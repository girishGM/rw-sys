/**
 * T-173 — the five new `BoundReward` fields served out of the **real** database, through the real
 * `CampaignConfigService`, encoded with the real proto codec (verification step 3).
 *
 * ### Why this suite exists next to the unit one
 *
 * `reward-expiry-duration.spec.ts` proves the assembly logic and the wire format in isolation, with
 * fixtures in memory. Neither of those can fail if the *query* is wrong — a column the model
 * declares but the migration never added, a `reward_app` grant that was never issued, a scope
 * predicate that silently matches nothing. Those are all claims about a running Postgres, so they
 * are asserted against one (AGENT-PROTOCOL §3: "at least one test must assert the outcome in a
 * client that actually enforces the rules"). In particular, the model attribute → column mapping
 * for `expiry_value`/`expiry_unit` exists **only** here: a typo in the `field:` name would leave
 * every unit test green and serve `0`/`''` for every reward in production.
 *
 * ### Why it assembles the service by hand rather than booting `AppModule`
 *
 * The same reasoning `activity-external-codes.e2e-spec.ts` (T-171) documents: the six collaborators
 * are directly constructible, the mTLS socket and grant lookup are covered end to end by
 * `grpc.e2e-spec.ts` and are untouched by this task (no new RPC, no new section, no new grant
 * shape), and booting `AppModule` would require the suite-encryption-key fixture that has orphaned
 * rows and broken later suites twice in this project (T-067, T-139).
 *
 * ### Isolation
 *
 * Every fixture is prefixed `T173E2E` and removed in `afterAll`. Reward versions are left `draft`
 * on purpose — `trg_reward_versions_undeletable` (T005_007) refuses to delete a published one, and
 * a suite that needed a superuser connection to clean up after itself would be a worse trade than
 * one reward system per scenario (`uq_rewv_one_draft` is per reward, so this is legal). Nothing the
 * builder does here depends on version status: a pin is read by id.
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

const PREFIX = 'T173E2E';
const IDENTITY = `${PREFIX}-runtime.internal`;
const CAMPAIGN_CODE = `${PREFIX}_C1`;
const EXPIRING_SYSTEM = `${PREFIX}_SYS_EXPIRING`;
const PLAIN_SYSTEM = `${PREFIX}_SYS_PLAIN`;
const PROMO_CONFIG_ID = '90210';

let db: Sequelize;
let service: CampaignConfigService;
let tenantId: number;
let campaignId: number;
let expiringVersionId: number;

async function sql<T extends object>(
  text: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return db.query<T>(text, { type: QueryTypes.SELECT, replacements });
}

async function exec(text: string, replacements: Record<string, unknown> = {}): Promise<void> {
  await db.query(text, { type: QueryTypes.RAW, replacements });
}

/** An identity granted BASIC + REWARDS on the fixture tenant. Built in memory: `grantFor` resolves
 * against the identity handed to it, never the database. */
function caller(): ResolvedServiceIdentity {
  return {
    identity: IDENTITY,
    grants: [
      {
        id: 1,
        serviceIdentity: IDENTITY,
        tenantId,
        allowedSections: ['BASIC', 'REWARDS'],
        status: 'active',
        createdBy: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  };
}

interface WireReward {
  readonly systemCode: string;
  readonly rewardType: string;
  readonly versionNo: number;
  readonly expiryValue: number;
  readonly expiryUnit: string;
  readonly rewardKind: string;
  readonly promoCodeConfigId: string;
  readonly promoCodeConfigVersionNo: number;
}

/** The campaign as a **decoded proto message** — what the consuming service actually sees, after a
 * real encode/decode round trip, not the builder's internal payload. */
async function fetchOverTheWire(): Promise<{ rewards: WireReward[]; configHash: string }> {
  const { config } = await service.getCampaignConfig(caller(), {
    tenantId,
    campaignCode: CAMPAIGN_CODE,
    etag: '',
    sections: [CONFIG_SECTION.BASIC, CONFIG_SECTION.REWARDS],
  });
  const decoded = decodeMessage(
    CampaignConfigMessage,
    encodeMessage(CampaignConfigMessage, config as unknown as Record<string, unknown>),
  ) as { rewards: WireReward[]; configHash: string };

  return { rewards: decoded.rewards, configHash: decoded.configHash };
}

function rewardFor(rewards: readonly WireReward[], systemCode: string): WireReward {
  const found = rewards.find((entry) => entry.systemCode === systemCode);
  if (found === undefined) throw new Error(`no BoundReward for ${systemCode} in the response`);
  return found;
}

async function purge(): Promise<void> {
  await exec(
    `DELETE FROM reward_config.reward_campaign_assignments
      WHERE campaign_id IN (SELECT id FROM reward_config.tenant_campaigns
                             WHERE campaign_code LIKE '${PREFIX}%')`,
  );
  await exec(`DELETE FROM reward_config.tenant_campaigns WHERE campaign_code LIKE '${PREFIX}%'`);
  await exec(
    `DELETE FROM reward_config.reward_versions
      WHERE reward_id IN (SELECT id FROM reward_config.reward_systems
                           WHERE system_code LIKE '${PREFIX}%')`,
  );
  await exec(
    `DELETE FROM reward_config.reward_policies
      WHERE reward_system_id IN (SELECT id FROM reward_config.reward_systems
                                  WHERE system_code LIKE '${PREFIX}%')`,
  );
  await exec(`DELETE FROM reward_config.reward_systems WHERE system_code LIKE '${PREFIX}%'`);
  await exec(`DELETE FROM reward_config.tenants WHERE code LIKE '${PREFIX}%'`);
}

/** One reward system + policy + draft version + campaign-level attachment, pinned to that version.
 * Returns the version id so a test can edit it. */
async function attachReward(options: {
  systemCode: string;
  expiry: { value: number; unit: string } | null;
  rewardKind: string | null;
  promoCodeConfig: string | null;
}): Promise<number> {
  const [system] = await sql<{ id: number }>(
    `INSERT INTO reward_config.reward_systems
       (tenant_id, system_code, name, reward_type, delivery_mode, connector_type, status)
     VALUES (:tenantId, :code, :code, 'CASHBACK', 'realtime', 'internal_api', 'active')
     RETURNING id`,
    { tenantId, code: options.systemCode },
  );
  const [policy] = await sql<{ id: number }>(
    `INSERT INTO reward_config.reward_policies
       (reward_system_id, policy_code, name, config, status)
     VALUES (:systemId, :code, :code, :config, 'active')
     RETURNING id`,
    {
      systemId: system.id,
      code: `${options.systemCode}_P1`,
      config:
        options.promoCodeConfig === null
          ? '{}'
          : JSON.stringify({ promoCodeConfig: options.promoCodeConfig }),
    },
  );
  const [version] = await sql<{ id: number }>(
    `INSERT INTO reward_config.reward_versions
       (reward_id, version_no, status, created_by, delivery_mode, unit_type, unit_code,
        reward_kind, expiry_value, expiry_unit)
     VALUES (:rewardId, 1, 'draft', 1, 'realtime', 'currency', 'MYR',
             :kind, :expiryValue, :expiryUnit)
     RETURNING id`,
    {
      rewardId: system.id,
      kind: options.rewardKind,
      expiryValue: options.expiry?.value ?? null,
      expiryUnit: options.expiry?.unit ?? null,
    },
  );
  await exec(
    `INSERT INTO reward_config.reward_campaign_assignments
       (tenant_id, reward_policy_id, campaign_id, reward_version_id, status)
     VALUES (:tenantId, :policyId, :campaignId, :versionId, 'active')`,
    { tenantId, policyId: policy.id, campaignId, versionId: version.id },
  );
  return version.id;
}

beforeAll(async () => {
  db = buildAppSequelize();
  await db.authenticate();

  const scoped = new ScopedRepository();
  service = new CampaignConfigService(
    db,
    scoped,
    new ConfigSnapshotBuilder(db, scoped),
    new ServiceScopeGuard({} as unknown as GrpcGrantsService),
    new ChangeEventPublisher(),
    new ServiceRateLimiter(),
  );

  await purge();

  const [country] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.countries ORDER BY id LIMIT 1',
  );
  if (country === undefined) throw new Error('no countries — run the seed migrations first');

  const [tenant] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES (:code, :code, :countryId, 'active') RETURNING id`,
    { code: `${PREFIX}_TENANT`, countryId: country.id },
  );
  tenantId = tenant.id;

  const [campaign] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenant_campaigns
       (tenant_id, campaign_code, name, start_date, end_date, status, created_by)
     VALUES (:tenantId, :code, :code, '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z',
             'active', '1')
     RETURNING id`,
    { tenantId, code: CAMPAIGN_CODE },
  );
  campaignId = campaign.id;

  expiringVersionId = await attachReward({
    systemCode: EXPIRING_SYSTEM,
    expiry: { value: 15, unit: 'minutes' },
    rewardKind: 'PERCENTAGE',
    promoCodeConfig: PROMO_CONFIG_ID,
  });
  await attachReward({
    systemCode: PLAIN_SYSTEM,
    expiry: null,
    rewardKind: null,
    promoCodeConfig: null,
  });
}, 60_000);

afterAll(async () => {
  if (db !== undefined) {
    await purge();
    await db.close();
  }
});

describe('T-173 — the new BoundReward fields over the real config service', () => {
  it('TC-2 — GetCampaignConfig serves the expiry duration a version actually carries', async () => {
    const { rewards } = await fetchOverTheWire();
    const expiring = rewardFor(rewards, EXPIRING_SYSTEM);

    expect(expiring.expiryValue).toBe(15);
    expect(expiring.expiryUnit).toBe('minutes');
  });

  it('TC-2 — ListActiveCampaigns serves it too (the cache-warming path)', async () => {
    const { list } = await service.listActiveCampaigns(caller(), {
      tenantId,
      sections: [CONFIG_SECTION.BASIC, CONFIG_SECTION.REWARDS],
    });
    const decoded = decodeMessage(
      CampaignConfigListMessage,
      encodeMessage(CampaignConfigListMessage, list),
    ) as { campaigns: { campaignCode: string; rewards: WireReward[] }[] };

    const listed = decoded.campaigns.find((entry) => entry.campaignCode === CAMPAIGN_CODE);
    expect(listed).toBeDefined();
    const expiring = rewardFor(listed?.rewards ?? [], EXPIRING_SYSTEM);

    expect(expiring.expiryValue).toBe(15);
    expect(expiring.expiryUnit).toBe('minutes');
  });

  it('TC-3 — a reward with no expiry configured serves 0/"" — never a fabricated default', async () => {
    const { rewards } = await fetchOverTheWire();
    const plain = rewardFor(rewards, PLAIN_SYSTEM);

    expect(plain.expiryValue).toBe(0);
    expect(plain.expiryUnit).toBe('');
  });

  it('TC-8 — reward_kind crosses the wire, distinct from reward_type', async () => {
    const { rewards } = await fetchOverTheWire();
    const expiring = rewardFor(rewards, EXPIRING_SYSTEM);

    expect(expiring.rewardKind).toBe('PERCENTAGE');
    // The gap this closes: before T-173 only `reward_type` was carried, and it says nothing about
    // whether `reward_value` is a rate or an amount.
    expect(expiring.rewardType).toBe('CASHBACK');
    expect(expiring.rewardKind).not.toBe(expiring.rewardType);
  });

  it('TC-9 — reward_kind IS NULL serves an empty string', async () => {
    const { rewards } = await fetchOverTheWire();

    expect(rewardFor(rewards, PLAIN_SYSTEM).rewardKind).toBe('');
  });

  it('TC-10 — promo_code_config_id comes straight from reward_policies.config', async () => {
    const { rewards } = await fetchOverTheWire();

    expect(rewardFor(rewards, EXPIRING_SYSTEM).promoCodeConfigId).toBe(PROMO_CONFIG_ID);
  });

  it('TC-11 — a policy with no promoCodeConfig serves "" and version 0', async () => {
    const { rewards } = await fetchOverTheWire();
    const plain = rewardFor(rewards, PLAIN_SYSTEM);

    expect(plain.promoCodeConfigId).toBe('');
    expect(plain.promoCodeConfigVersionNo).toBe(0);
  });

  it('promo_code_config_version_no is 0 even where a config IS bound (T-174 owns it)', async () => {
    const { rewards } = await fetchOverTheWire();

    expect(rewardFor(rewards, EXPIRING_SYSTEM).promoCodeConfigVersionNo).toBe(0);
  });

  it('the expiry is inside the hashed payload, so changing it invalidates a cached config', async () => {
    // If the fields were assembled after hashing (or dropped from the canonical payload), a runtime
    // holding an ETag would keep serving the old expiry forever — the cache-invalidation property
    // 09-INTEGRATION.md §11 depends on.
    const before = await fetchOverTheWire();
    await exec(
      `UPDATE reward_config.reward_versions SET expiry_value = 45, expiry_unit = 'days'
        WHERE id = :id`,
      { id: expiringVersionId },
    );

    const after = await fetchOverTheWire();
    expect(after.configHash).not.toBe(before.configHash);
    expect(rewardFor(after.rewards, EXPIRING_SYSTEM).expiryValue).toBe(45);
    expect(rewardFor(after.rewards, EXPIRING_SYSTEM).expiryUnit).toBe('days');

    await exec(
      `UPDATE reward_config.reward_versions SET expiry_value = 15, expiry_unit = 'minutes'
        WHERE id = :id`,
      { id: expiringVersionId },
    );
    expect((await fetchOverTheWire()).configHash).toBe(before.configHash);
  });

  it('serves a stable response across repeated calls (config_hash is deterministic)', async () => {
    const first = await fetchOverTheWire();
    const second = await fetchOverTheWire();

    expect(first.rewards).toEqual(second.rewards);
    expect(first.configHash).toBe(second.configHash);
  });

  it('BASIC alone still serves no rewards at all — the section boundary is unchanged', async () => {
    const { config } = await service.getCampaignConfig(caller(), {
      tenantId,
      campaignCode: CAMPAIGN_CODE,
      etag: '',
      sections: [CONFIG_SECTION.BASIC],
    });

    expect((config as { rewards: unknown[] }).rewards).toEqual([]);
  });
});
