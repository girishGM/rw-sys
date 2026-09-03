/**
 * T-171 — `Activity.external_codes` served out of the **real** database, through the real
 * `CampaignConfigService`, encoded with the real proto codec.
 *
 * ### Why this suite exists next to the unit one
 *
 * `activity-external-codes.spec.ts` proves the assembly logic and the wire format in isolation,
 * with fixtures in memory. Neither of those can fail if the *query* is wrong — a tenancy predicate
 * that silently matches nothing, an index that isn't there, a `reward_app` grant that was never
 * issued. Those are all claims about a running Postgres, so they are asserted against one
 * (AGENT-PROTOCOL §3: "at least one test must assert the outcome in a client that actually enforces
 * the rules"). TC-2, TC-3 and TC-4 all live here for that reason.
 *
 * ### Why it assembles the service by hand rather than booting `AppModule`
 *
 * `CampaignConfigService`'s six collaborators are all directly constructible, and the two things a
 * full Nest boot would add — the mTLS socket and the `grpc_service_grants` lookup — are already
 * covered end to end by `grpc.e2e-spec.ts` and are untouched by this task (no new RPC, no new
 * section, no new grant shape). Booting `AppModule` would additionally require inserting suite
 * encryption keys, which is the exact fixture that has orphaned rows and broken later suites twice
 * in this project (T-067, T-139). This suite writes only its own six tables and deletes all of it.
 *
 * ### Isolation
 *
 * Every fixture is prefixed `T171E2E` and removed in `afterAll`. Nothing counts rows globally.
 */
import 'reflect-metadata';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { ConfigSnapshotBuilder } from '@/grpc/config-snapshot.builder';
import { CampaignConfigService } from '@/grpc/campaign-config.service';
import { ServiceScopeGuard, type ResolvedServiceIdentity } from '@/grpc/service-scope.guard';
import { ChangeEventPublisher } from '@/grpc/change-event.publisher';
import { ServiceRateLimiter } from '@/grpc/rate-limit';
import { CONFIG_SECTION } from '@/grpc/grpc.constants';
import { decodeMessage, encodeMessage } from '@/grpc/wire/proto-codec';
import {
  CampaignConfigListMessage,
  CampaignConfigMessage,
} from '@/grpc/wire/campaign-config.messages';
import type { GrpcGrantsService } from '@/modules/access-control/grpc-grants.service';
import { buildAppSequelize } from '../database/build-app-sequelize';

const PREFIX = 'T171E2E';
const IDENTITY = `${PREFIX}-runtime.internal`;

let db: Sequelize;
let service: CampaignConfigService;

let countryId: number;
let tenantA: number;
let tenantB: number;
let merchantId: number;
let mappedActivityId: number;
let unmappedActivityId: number;
let tenantBActivityId: number;
let campaignId: number;

const CAMPAIGN_CODE = `${PREFIX}_C1`;
const MAPPED_ACTIVITY = `${PREFIX}_ACT_MAPPED`;
const UNMAPPED_ACTIVITY = `${PREFIX}_ACT_UNMAPPED`;

async function sql<T extends object>(
  text: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return db.query<T>(text, { type: QueryTypes.SELECT, replacements });
}

async function exec(text: string, replacements: Record<string, unknown> = {}): Promise<void> {
  await db.query(text, { type: QueryTypes.RAW, replacements });
}

/**
 * The Postgres constraint an insert actually violated, or `null` if it succeeded.
 *
 * Sequelize renders a unique violation as `UniqueConstraintError: Validation error`, which names
 * nothing — asserting on that string would pass just as happily if a *different* constraint had
 * fired, or if the index had been built on the wrong columns. The driver keeps the real constraint
 * name on the wrapped error, and that is what the assertions below read.
 */
async function constraintViolatedBy(
  text: string,
  replacements: Record<string, unknown>,
): Promise<string | null> {
  try {
    await exec(text, replacements);
    return null;
  } catch (err) {
    const original = (
      err as { parent?: { constraint?: string }; original?: { constraint?: string } }
    ).parent;
    return original?.constraint ?? null;
  }
}

const INSERT_CODE = `INSERT INTO reward_portal.activity_external_codes
       (tenant_id, activity_id, external_code)
     VALUES (:tenantId, :activityId, :code)`;

/** An identity granted BASIC + MERCHANTS on tenant A. Built in memory: `grantFor` reads only
 * what is handed to it, and this task changes nothing about how a grant is resolved. */
function caller(tenantId: number | null = tenantA): ResolvedServiceIdentity {
  return {
    identity: IDENTITY,
    grants: [
      {
        id: 1,
        serviceIdentity: IDENTITY,
        tenantId,
        allowedSections: ['BASIC', 'MERCHANTS'],
        status: 'active',
        createdBy: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  };
}

interface WireActivity {
  readonly activityId: number;
  readonly activityCode: string;
  readonly name: string;
  readonly externalCodes: readonly string[];
}

/** The campaign as a **decoded proto message** — i.e. what the consuming service actually sees,
 * after a real encode/decode round trip, not the builder's internal payload. */
async function fetchOverTheWire(): Promise<{ activities: WireActivity[]; configHash: string }> {
  const { config } = await service.getCampaignConfig(caller(), {
    tenantId: tenantA,
    campaignCode: CAMPAIGN_CODE,
    etag: '',
    sections: [CONFIG_SECTION.BASIC, CONFIG_SECTION.MERCHANTS],
  });
  const decoded = decodeMessage(
    CampaignConfigMessage,
    encodeMessage(CampaignConfigMessage, config as unknown as Record<string, unknown>),
  ) as { merchants: { activities: WireActivity[] }[]; configHash: string };

  return { activities: decoded.merchants[0].activities, configHash: decoded.configHash };
}

async function purge(): Promise<void> {
  await exec(
    `DELETE FROM reward_portal.activity_external_codes
      WHERE external_code LIKE '${PREFIX}%'
         OR activity_id IN (SELECT id FROM reward_config.activities
                             WHERE activity_code LIKE '${PREFIX}%')`,
  );
  await exec(
    `DELETE FROM reward_config.campaign_merchants
      WHERE campaign_id IN (SELECT id FROM reward_config.tenant_campaigns
                             WHERE campaign_code LIKE '${PREFIX}%')`,
  );
  await exec(`DELETE FROM reward_config.tenant_campaigns WHERE campaign_code LIKE '${PREFIX}%'`);
  await exec(
    `DELETE FROM reward_config.merchant_activities
      WHERE activity_id IN (SELECT id FROM reward_config.activities
                             WHERE activity_code LIKE '${PREFIX}%')`,
  );
  await exec(`DELETE FROM reward_config.activities WHERE activity_code LIKE '${PREFIX}%'`);
  await exec(`DELETE FROM reward_config.merchants WHERE merchant_code LIKE '${PREFIX}%'`);
  await exec(`DELETE FROM reward_config.tenants WHERE code LIKE '${PREFIX}%'`);
}

beforeAll(async () => {
  db = buildAppSequelize();
  await db.authenticate();

  const scoped = new ScopedRepository();
  service = new CampaignConfigService(
    db,
    scoped,
    new ConfigSnapshotBuilder(db, scoped),
    // The guard's `grantFor` is pure — it resolves against the identity handed to it, never the
    // database — so the admin service behind it is never reached from this suite.
    new ServiceScopeGuard({} as unknown as GrpcGrantsService),
    new ChangeEventPublisher(),
    new ServiceRateLimiter(),
  );

  await purge();

  const [country] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.countries ORDER BY id LIMIT 1',
  );
  if (country === undefined) throw new Error('no countries — run the seed migrations first');
  countryId = country.id;

  const makeTenant = async (suffix: string): Promise<number> => {
    const [created] = await sql<{ id: number }>(
      `INSERT INTO reward_config.tenants (code, name, country_id, status)
       VALUES (:code, :code, :countryId, 'active') RETURNING id`,
      { code: `${PREFIX}_TENANT_${suffix}`, countryId },
    );
    return created.id;
  };
  tenantA = await makeTenant('A');
  tenantB = await makeTenant('B');

  const [merchant] = await sql<{ id: number }>(
    `INSERT INTO reward_config.merchants (tenant_id, merchant_code, name, country_code, status)
     VALUES (:tenantId, :code, :code,
             (SELECT code FROM reward_config.countries WHERE id = :countryId), 'active')
     RETURNING id`,
    { tenantId: tenantA, code: `${PREFIX}_M1`, countryId },
  );
  merchantId = merchant.id;

  const [activityType] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.activity_types ORDER BY id LIMIT 1',
  );
  const makeActivity = async (tenantId: number, code: string): Promise<number> => {
    const [created] = await sql<{ id: number }>(
      `INSERT INTO reward_config.activities (tenant_id, type_id, activity_code, name, status)
       VALUES (:tenantId, :typeId, :code, :code, 'active') RETURNING id`,
      { tenantId, typeId: activityType.id, code },
    );
    return created.id;
  };
  mappedActivityId = await makeActivity(tenantA, MAPPED_ACTIVITY);
  unmappedActivityId = await makeActivity(tenantA, UNMAPPED_ACTIVITY);
  tenantBActivityId = await makeActivity(tenantB, `${PREFIX}_ACT_TENANT_B`);

  for (const activityId of [mappedActivityId, unmappedActivityId]) {
    await exec(
      `INSERT INTO reward_config.merchant_activities (tenant_id, merchant_id, activity_id, status)
       VALUES (:tenantId, :merchantId, :activityId, 'active')`,
      { tenantId: tenantA, merchantId, activityId },
    );
  }

  const [campaign] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenant_campaigns
       (tenant_id, campaign_code, name, start_date, end_date, status, created_by)
     VALUES (:tenantId, :code, :code, '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z',
             'active', '1')
     RETURNING id`,
    { tenantId: tenantA, code: CAMPAIGN_CODE },
  );
  campaignId = campaign.id;
  await exec(
    `INSERT INTO reward_config.campaign_merchants (tenant_id, campaign_id, merchant_id, status)
     VALUES (:tenantId, :campaignId, :merchantId, 'active')`,
    { tenantId: tenantA, campaignId, merchantId },
  );

  // Two codes for one activity, deliberately inserted in the *reverse* of the order they must be
  // served in, so a passing ordering assertion cannot be an accident of insertion order.
  await exec(
    `INSERT INTO reward_portal.activity_external_codes (tenant_id, activity_id, external_code)
     VALUES (:tenantId, :activityId, :second), (:tenantId, :activityId, :first)`,
    {
      tenantId: tenantA,
      activityId: mappedActivityId,
      first: `${PREFIX}_CARD_TXN`,
      second: `${PREFIX}_POS_SALE`,
    },
  );
}, 60_000);

afterAll(async () => {
  if (db !== undefined) {
    await purge();
    await db.close();
  }
});

describe('T-171 — external codes over the real config service', () => {
  it('TC-2 — GetCampaignConfig serves both codes of a mapped activity', async () => {
    const { activities } = await fetchOverTheWire();
    const mapped = activities.find((entry) => entry.activityCode === MAPPED_ACTIVITY);

    expect(mapped).toBeDefined();
    expect(mapped?.externalCodes).toEqual([`${PREFIX}_CARD_TXN`, `${PREFIX}_POS_SALE`]);
  });

  it('TC-2 — ListActiveCampaigns serves them too (cache-warming path)', async () => {
    const { list } = await service.listActiveCampaigns(caller(), {
      tenantId: tenantA,
      sections: [CONFIG_SECTION.BASIC, CONFIG_SECTION.MERCHANTS],
    });
    const decoded = decodeMessage(
      CampaignConfigListMessage,
      encodeMessage(CampaignConfigListMessage, list),
    ) as {
      campaigns: { campaignCode: string; merchants: { activities: WireActivity[] }[] }[];
    };

    const listed = decoded.campaigns.find((entry) => entry.campaignCode === CAMPAIGN_CODE);
    const mapped = listed?.merchants[0].activities.find(
      (entry) => entry.activityCode === MAPPED_ACTIVITY,
    );

    expect(mapped?.externalCodes).toEqual([`${PREFIX}_CARD_TXN`, `${PREFIX}_POS_SALE`]);
  });

  it('TC-3 — an activity with no mapping decodes as an empty list, not a missing field', async () => {
    const { activities } = await fetchOverTheWire();
    const unmapped = activities.find((entry) => entry.activityCode === UNMAPPED_ACTIVITY);

    expect(unmapped).toBeDefined();
    expect(unmapped?.externalCodes).toEqual([]);
  });

  it('serves codes in a deterministic order regardless of physical row order', async () => {
    // The fixture inserted POS_SALE first. If the builder relied on insertion order, this would
    // come back reversed — and `config_hash` would differ between two identical databases.
    const first = await fetchOverTheWire();
    const second = await fetchOverTheWire();

    expect(first.activities).toEqual(second.activities);
    expect(first.configHash).toBe(second.configHash);
  });

  it('the codes are inside the hashed payload, so adding one invalidates the cache', async () => {
    const before = await fetchOverTheWire();
    await exec(
      `INSERT INTO reward_portal.activity_external_codes (tenant_id, activity_id, external_code)
       VALUES (:tenantId, :activityId, :code)`,
      { tenantId: tenantA, activityId: mappedActivityId, code: `${PREFIX}_ZZ_EXTRA` },
    );

    const after = await fetchOverTheWire();
    expect(after.configHash).not.toBe(before.configHash);

    await exec(`DELETE FROM reward_portal.activity_external_codes WHERE external_code = :code`, {
      code: `${PREFIX}_ZZ_EXTRA`,
    });
  });

  it("another tenant's identical code never appears on this tenant's activity", async () => {
    // The whole reason `uc_activity_external_codes` is keyed on (tenant_id, external_code): two
    // tenants may legitimately both call the same transaction type CARD_TXN.
    await exec(
      `INSERT INTO reward_portal.activity_external_codes (tenant_id, activity_id, external_code)
       VALUES (:tenantId, :activityId, :code)`,
      { tenantId: tenantB, activityId: tenantBActivityId, code: `${PREFIX}_CARD_TXN` },
    );

    const { activities } = await fetchOverTheWire();
    const mapped = activities.find((entry) => entry.activityCode === MAPPED_ACTIVITY);

    expect(mapped?.externalCodes).toEqual([`${PREFIX}_CARD_TXN`, `${PREFIX}_POS_SALE`]);
    const rows = await sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_portal.activity_external_codes
        WHERE external_code = :code`,
      { code: `${PREFIX}_CARD_TXN` },
    );
    expect(rows[0].count).toBe('2');
  });

  it('TC-4 — a duplicate code within one tenant is rejected, on a DIFFERENT activity', async () => {
    // The ambiguity the index exists to prevent: one transactionType resolving to two activities.
    const violated = await constraintViolatedBy(INSERT_CODE, {
      tenantId: tenantA,
      activityId: unmappedActivityId,
      code: `${PREFIX}_CARD_TXN`,
    });

    expect(violated).toBe('uc_activity_external_codes');
  });

  it('TC-4 — the same activity cannot claim one code twice either', async () => {
    const violated = await constraintViolatedBy(INSERT_CODE, {
      tenantId: tenantA,
      activityId: mappedActivityId,
      code: `${PREFIX}_CARD_TXN`,
    });

    expect(violated).toBe('uc_activity_external_codes');
  });

  it('rejects a blank external code (ck_aec_external_code)', async () => {
    const violated = await constraintViolatedBy(
      `INSERT INTO reward_portal.activity_external_codes
         (tenant_id, activity_id, external_code)
       VALUES (:tenantId, :activityId, '   ')`,
      { tenantId: tenantA, activityId: mappedActivityId },
    );

    expect(violated).toBe('ck_aec_external_code');
  });

  it('BASIC alone still serves no merchants at all — the section boundary is unchanged', async () => {
    const { config } = await service.getCampaignConfig(caller(), {
      tenantId: tenantA,
      campaignCode: CAMPAIGN_CODE,
      etag: '',
      sections: [CONFIG_SECTION.BASIC],
    });

    expect((config as { merchants: unknown[] }).merchants).toEqual([]);
  });
});
