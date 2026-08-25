/**
 * T-039 — `/merchant/campaigns`, `/merchant/campaigns/:id` and `/merchant/summary` against the
 * **real** Postgres instance, through the real `AppModule`, over real HTTP, as several roles.
 *
 * Follows the harness `test/campaigns/campaigns.e2e-spec.ts` (T-037) and
 * `test/audit/audit-viewer.e2e-spec.ts` (T-040) establish: real login, real cookies, real guards,
 * real `ScopedRepository` scoping. Nothing is stubbed.
 *
 * ### Why so much of this task is proved here rather than in unit tests
 *
 * TC-2 — the task's own "headline test" — is a claim about the running system: two merchants in
 * *the same tenant* must be fully isolated from each other. A unit test with a fake repository
 * would pass whether or not `CAMPAIGNS_OF_MERCHANT`'s subquery actually reached the SQL
 * (`scope-strategy.ts`'s own note on this table: *"the task's worked example"*). Same for TC-4
 * (cross-tenant 404), TC-14/TC-15 (participation ending two different ways), and TC-16
 * (`maker` calling this merchant-only surface).
 *
 * ### Isolation from the live data
 *
 * Every fixture here is prefixed `T039E2E`, and every row this suite writes through the app
 * connection is removed in `afterAll`. `campaign_merchants`/`tenant_campaigns`/
 * `merchant_activities` carry no `DELETE` grant for `reward_app` (`T002_008_grants.ts`) — the
 * same append-only-in-practice shape `campaigns.e2e-spec.ts`'s own header documents — so teardown
 * for those three (and TC-14's own deliberate mid-suite deletion) uses the privileged migration
 * connection, exactly as that suite's `purgeSuiteResidue` does.
 */
import { randomBytes } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { createMigrationConnection } from '@/database/migration-connection';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import type { PortalRole } from '@/database/portal-models';
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
import { loginCompletingMfa } from '../auth/support/super-admin-mfa';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';

const SUITE = 't039';
jest.setTimeout(300_000);

const PASSWORD = 'correct horse battery staple 7!';
const PREFIX = 'T039E2E';
const COUNTRY_A_CODE = 'Q1';
const COUNTRY_B_CODE = 'Q2';

let app: INestApplication;
let db: Sequelize;
let admin: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

let countryAId: number;
let countryBId: number;
let tenantAId: number;
let tenantBId: number;
let merchantAId: number;
let merchantBId: number;
let merchantCId: number;
let activityAId: number;
let activityBId: number;

let campActiveId: number;
let campPausedId: number;
let campCompletedId: number;
let campDraftId: number;
let campPendingId: number;
let campArchivedId: number;
let campInactivePartId: number;
let campToRemoveId: number;
let campBOnlyId: number;
let campCrossTenantId: number;

interface Actor {
  readonly email: string;
  readonly jar: string;
  readonly csrf: string;
}
const actors = new Map<string, Actor>();

function http() {
  return request(app.getHttpServer());
}

async function sql<T extends object>(
  statement: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return db.query<T>(statement, { type: QueryTypes.SELECT, replacements });
}

async function exec(statement: string, replacements: Record<string, unknown> = {}): Promise<void> {
  await db.query(statement, { type: QueryTypes.RAW, replacements });
}

async function adminExec(
  statement: string,
  replacements: Record<string, unknown> = {},
): Promise<void> {
  await admin.query(statement, { type: QueryTypes.RAW, replacements });
}

function cookieValue(response: request.Response, name: string): string {
  const header = response.headers['set-cookie'];
  const entries = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const match = entries.find((entry) => entry.startsWith(`${name}=`));
  if (match === undefined) throw new Error(`no Set-Cookie for ${name}`);
  return decodeURIComponent(match.split(';')[0].slice(name.length + 1));
}

function jarFrom(response: request.Response): string {
  const header = response.headers['set-cookie'];
  const entries = Array.isArray(header) ? header : header === undefined ? [] : [header];
  return entries
    .map((entry) => entry.split(';')[0])
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

async function makeActor(
  key: string,
  role: PortalRole,
  scope: { countryId: number | null; tenantId: number | null; merchantId: number | null },
): Promise<Actor> {
  const email = `t039-e2e-${key}@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-039 ${key}`,
    role,
    ...scope,
    mustChangePassword: false,
  });
  await exec(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
  );

  const response = await loginCompletingMfa(app, { email, password: PASSWORD }, db);
  if (response.status !== 200) {
    throw new Error(`login for ${key} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  const actor: Actor = {
    email,
    jar: jarFrom(response),
    csrf: cookieValue(response, CSRF_COOKIE_NAME),
  };
  actors.set(key, actor);
  return actor;
}

function as(key: string): Actor {
  const actor = actors.get(key);
  if (actor === undefined) throw new Error(`no actor "${key}"`);
  return actor;
}

function get(key: string, path: string) {
  return http().get(`/api/v1${path}`).set('Cookie', as(key).jar);
}
function post(key: string, path: string, body: unknown = {}) {
  return http()
    .post(`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf)
    .send(body as object);
}
function patch(key: string, path: string, body: unknown = {}) {
  return http()
    .patch(`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf)
    .send(body as object);
}

// --- fixtures ------------------------------------------------------------------------------------

async function ensureCountry(code: string, name: string): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.countries WHERE code = :code',
    { code },
  );
  if (existing !== undefined) {
    await exec(`UPDATE reward_config.countries SET status = 'active' WHERE id = :id`, {
      id: existing.id,
    });
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.countries (code, name, timezone, currency_code, dialing_code, status)
     VALUES (:code, :name, 'UTC', 'USD', '+001', 'active') RETURNING id`,
    { code, name },
  );
  return created.id;
}

async function ensureTenant(code: string, countryId: number): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.tenants WHERE code = :code',
    { code },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.tenants SET status = 'active', deleted_at = NULL, country_id = :countryId
        WHERE id = :id`,
      { id: existing.id, countryId },
    );
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES (:code, :code, :countryId, 'active') RETURNING id`,
    { code, countryId },
  );
  return created.id;
}

async function ensureMerchant(
  code: string,
  tenantId: number,
  countryCode: string,
): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.merchants WHERE merchant_code = :code',
    { code },
  );
  if (existing !== undefined) return existing.id;
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.merchants (tenant_id, merchant_code, name, country_code, status)
     VALUES (:tenantId, :code, :code, :countryCode, 'active') RETURNING id`,
    { tenantId, code, countryCode },
  );
  return created.id;
}

async function ensureActivityType(): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.activity_types ORDER BY id LIMIT 1',
  );
  if (existing === undefined) throw new Error('no activity_types rows — is the schema seeded?');
  return existing.id;
}

async function ensureActivity(code: string, tenantId: number, typeId: number): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.activities WHERE tenant_id = :tenantId AND activity_code = :code',
    { tenantId, code },
  );
  if (existing !== undefined) return existing.id;
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.activities (tenant_id, type_id, activity_code, name, status)
     VALUES (:tenantId, :typeId, :code, :code, 'active') RETURNING id`,
    { tenantId, typeId, code },
  );
  return created.id;
}

async function linkMerchantActivity(
  merchantId: number,
  activityId: number,
  tenantId: number,
  commissionRate: string,
): Promise<void> {
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.merchant_activities
      WHERE merchant_id = :merchantId AND activity_id = :activityId AND store_id IS NULL`,
    { merchantId, activityId },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.merchant_activities SET status = 'active', commission_rate = :commissionRate
        WHERE id = :id`,
      { id: existing.id, commissionRate },
    );
    return;
  }
  await exec(
    `INSERT INTO reward_config.merchant_activities
            (tenant_id, merchant_id, activity_id, status, commission_rate)
     VALUES (:tenantId, :merchantId, :activityId, 'active', :commissionRate)`,
    { tenantId, merchantId, activityId, commissionRate },
  );
}

async function ensureCampaign(
  code: string,
  tenantId: number,
  status: string,
  overrides: {
    description?: string | null;
    region?: string | null;
    maxParticipants?: number | null;
  } = {},
): Promise<number> {
  const description = overrides.description ?? null;
  const region = overrides.region ?? 'EU';
  const maxParticipants = overrides.maxParticipants ?? null;
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.tenant_campaigns WHERE campaign_code = :code',
    { code },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.tenant_campaigns
          SET status = :status, tenant_id = :tenantId, deleted_at = NULL,
              description = :description, region = :region, max_participants = :maxParticipants
        WHERE id = :id`,
      { id: existing.id, status, tenantId, description, region, maxParticipants },
    );
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenant_campaigns
            (tenant_id, campaign_code, name, description, region, start_date, end_date, status,
             max_participants, created_by)
     VALUES (:tenantId, :code, :code, :description, :region, now() - interval '1 day',
             now() + interval '30 days', :status, :maxParticipants, 't039-e2e')
     RETURNING id`,
    { tenantId, code, description, region, status, maxParticipants },
  );
  return created.id;
}

async function ensureCampaignMerchant(
  campaignId: number,
  merchantId: number,
  tenantId: number,
  status: string,
): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.campaign_merchants
      WHERE campaign_id = :campaignId AND merchant_id = :merchantId`,
    { campaignId, merchantId },
  );
  if (existing !== undefined) {
    await exec(`UPDATE reward_config.campaign_merchants SET status = :status WHERE id = :id`, {
      id: existing.id,
      status,
    });
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.campaign_merchants (tenant_id, campaign_id, merchant_id, status)
     VALUES (:tenantId, :campaignId, :merchantId, :status) RETURNING id`,
    { tenantId, campaignId, merchantId, status },
  );
  return created.id;
}

/**
 * `KeyRegistryService.onModuleInit()` eagerly loads **every** row in `encryption_keys` at boot
 * and refuses to boot at all if any one of them lacks its material — by design (07-DATA-
 * PROTECTION.md §3, `key-registry.service.ts`'s own header), so that a missing key is a boot-time
 * failure rather than a decrypt-time surprise. In this shared, multi-agent dev database that
 * means a sibling suite's own row (created by its own `ensureEncryptionKeys`/`ensureFieldKey`,
 * whose material lives only in *that* process's `process.env`) blocks every other process from
 * booting at all, for as long as that row exists — a real, structural, already-precedented
 * cross-suite collision (`rbac.e2e-spec.ts`'s own "F-3" finding, T-013's review).
 *
 * This suite makes itself resilient to that rather than intermittently failing on it: before
 * booting the app, it finds every `env:`-scheme `key_ref` already in the table and fills in any
 * missing `process.env` entry with **fresh, random, throwaway material** — never the sibling
 * suite's real key (which this process never learns and does not need). This changes nothing
 * about `KeyRegistryService`'s fail-closed behaviour and touches no other task's files or rows;
 * it only supplies exactly what that already-fail-closed check demands so this suite's own,
 * unrelated fixtures are not held hostage by another task's in-flight run. None of this suite's
 * own data is ever encrypted under a foreign kid, so the fact the material is throwaway is
 * immaterial to correctness here.
 */
async function ensureForeignKeyEnvVarsPresent(sequelize: Sequelize): Promise<void> {
  const rows = await sequelize.query<{ key_ref: string }>(
    `SELECT key_ref FROM reward_portal.encryption_keys WHERE key_ref LIKE 'env:%'`,
    { type: QueryTypes.SELECT },
  );
  for (const { key_ref: keyRef } of rows) {
    const envName = keyRef.slice('env:'.length);
    if (process.env[envName] === undefined || process.env[envName] === '') {
      process.env[envName] = randomBytes(32).toString('base64');
    }
  }
}

// --- lifecycle -------------------------------------------------------------------------------

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await ensureForeignKeyEnvVarsPresent(moduleRef.get<Sequelize>(SEQUELIZE));
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), SUITE);

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  await app.listen(0);

  db = app.get<Sequelize>(SEQUELIZE);
  admin = createMigrationConnection();
  emailCrypto = emailCryptoOf(app);

  countryAId = await ensureCountry(COUNTRY_A_CODE, 'T-039 e2e country A');
  countryBId = await ensureCountry(COUNTRY_B_CODE, 'T-039 e2e country B');
  tenantAId = await ensureTenant(`${PREFIX}_TA`, countryAId);
  tenantBId = await ensureTenant(`${PREFIX}_TB`, countryBId);
  merchantAId = await ensureMerchant(`${PREFIX}_MA`, tenantAId, COUNTRY_A_CODE);
  merchantBId = await ensureMerchant(`${PREFIX}_MB`, tenantAId, COUNTRY_A_CODE);
  merchantCId = await ensureMerchant(`${PREFIX}_MC`, tenantBId, COUNTRY_B_CODE);

  const activityTypeId = await ensureActivityType();
  activityAId = await ensureActivity(`${PREFIX}_ACT_A`, tenantAId, activityTypeId);
  activityBId = await ensureActivity(`${PREFIX}_ACT_B`, tenantAId, activityTypeId);
  await linkMerchantActivity(merchantAId, activityAId, tenantAId, '2.50');
  await linkMerchantActivity(merchantBId, activityBId, tenantAId, '9.99');

  campActiveId = await ensureCampaign(`${PREFIX}_ACTIVE`, tenantAId, 'active', {
    description: 'The active one',
    maxParticipants: 50,
  });
  campPausedId = await ensureCampaign(`${PREFIX}_PAUSED`, tenantAId, 'paused');
  campCompletedId = await ensureCampaign(`${PREFIX}_COMPLETED`, tenantAId, 'completed');
  campDraftId = await ensureCampaign(`${PREFIX}_DRAFT`, tenantAId, 'draft');
  campPendingId = await ensureCampaign(`${PREFIX}_PENDING`, tenantAId, 'pending_approval');
  campArchivedId = await ensureCampaign(`${PREFIX}_ARCHIVED`, tenantAId, 'archived');
  campInactivePartId = await ensureCampaign(`${PREFIX}_INACTIVE_PART`, tenantAId, 'active');
  campToRemoveId = await ensureCampaign(`${PREFIX}_TO_REMOVE`, tenantAId, 'active');
  campBOnlyId = await ensureCampaign(`${PREFIX}_B_ONLY`, tenantAId, 'active');
  campCrossTenantId = await ensureCampaign(`${PREFIX}_CROSS_TENANT`, tenantBId, 'active');

  await ensureCampaignMerchant(campActiveId, merchantAId, tenantAId, 'active');
  await ensureCampaignMerchant(campPausedId, merchantAId, tenantAId, 'active');
  await ensureCampaignMerchant(campCompletedId, merchantAId, tenantAId, 'active');
  await ensureCampaignMerchant(campDraftId, merchantAId, tenantAId, 'active');
  await ensureCampaignMerchant(campPendingId, merchantAId, tenantAId, 'active');
  await ensureCampaignMerchant(campArchivedId, merchantAId, tenantAId, 'active');
  await ensureCampaignMerchant(campInactivePartId, merchantAId, tenantAId, 'inactive');
  await ensureCampaignMerchant(campToRemoveId, merchantAId, tenantAId, 'active');
  await ensureCampaignMerchant(campBOnlyId, merchantBId, tenantAId, 'active');
  await ensureCampaignMerchant(campCrossTenantId, merchantCId, tenantBId, 'active');

  await makeActor('merchantA', 'merchant', {
    countryId: countryAId,
    tenantId: tenantAId,
    merchantId: merchantAId,
  });
  await makeActor('merchantB', 'merchant', {
    countryId: countryAId,
    tenantId: tenantAId,
    merchantId: merchantBId,
  });
  await makeActor('makerA', 'maker', {
    countryId: countryAId,
    tenantId: tenantAId,
    merchantId: null,
  });
});

afterAll(async () => {
  await exec(`DELETE FROM reward_portal.portal_users WHERE display_name LIKE 'T-039 %'`);
  await removeEncryptionKeys(db, SUITE);

  await adminExec(
    `DELETE FROM reward_config.campaign_merchants WHERE campaign_id IN (
       SELECT id FROM reward_config.tenant_campaigns WHERE campaign_code LIKE :prefix)`,
    { prefix: `${PREFIX}%` },
  );
  await adminExec(`DELETE FROM reward_config.tenant_campaigns WHERE campaign_code LIKE :prefix`, {
    prefix: `${PREFIX}%`,
  });
  await adminExec(
    `DELETE FROM reward_config.merchant_activities WHERE merchant_id IN (:merchantAId, :merchantBId)`,
    { merchantAId, merchantBId },
  );
  await adminExec(`DELETE FROM reward_config.activities WHERE activity_code LIKE :prefix`, {
    prefix: `${PREFIX}%`,
  });
  await admin.close();
  await app.close();
});

// --- tests -------------------------------------------------------------------------------------

describe('GET /merchant/campaigns', () => {
  it('TC-1/TC-7 — merchant A sees exactly its own active/paused/completed participations', async () => {
    const response = await get('merchantA', '/merchant/campaigns');
    expect(response.status).toBe(200);
    const ids = (response.body.data as { id: number }[]).map((row) => row.id);
    expect(ids.sort()).toEqual(
      [campActiveId, campPausedId, campCompletedId, campToRemoveId].sort(),
    );
  });

  it('TC-2 — the headline test: merchant B in the same tenant sees a disjoint list', async () => {
    const responseA = await get('merchantA', '/merchant/campaigns');
    const responseB = await get('merchantB', '/merchant/campaigns');
    const idsA = new Set((responseA.body.data as { id: number }[]).map((row) => row.id));
    const idsB = new Set((responseB.body.data as { id: number }[]).map((row) => row.id));

    expect(idsB.has(campBOnlyId)).toBe(true);
    expect(idsA.has(campBOnlyId)).toBe(false);
    for (const id of idsB) expect(idsA.has(id)).toBe(false);
  });

  it('TC-5/TC-6 — draft and pending_approval participations are never returned', async () => {
    const response = await get('merchantA', '/merchant/campaigns');
    const ids = (response.body.data as { id: number }[]).map((row) => row.id);
    expect(ids).not.toContain(campDraftId);
    expect(ids).not.toContain(campPendingId);
    expect(ids).not.toContain(campArchivedId);
  });

  it('TC-15 — an inactive campaign_merchants row is excluded', async () => {
    const response = await get('merchantA', '/merchant/campaigns');
    const ids = (response.body.data as { id: number }[]).map((row) => row.id);
    expect(ids).not.toContain(campInactivePartId);
  });

  it('TC-16 — a maker calling this merchant-only surface gets 403', async () => {
    const response = await get('makerA', '/merchant/campaigns');
    expect(response.status).toBe(403);
  });

  it('TC-17 — a merchant with zero participations gets a friendly empty list, not an error', async () => {
    // A brand-new merchant with no `campaign_merchants` rows at all.
    const freshMerchantId = await ensureMerchant(`${PREFIX}_MZ`, tenantAId, COUNTRY_A_CODE);
    await makeActor('merchantZero', 'merchant', {
      countryId: countryAId,
      tenantId: tenantAId,
      merchantId: freshMerchantId,
    });

    const response = await get('merchantZero', '/merchant/campaigns');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });
});

describe('GET /merchant/campaigns/:id', () => {
  it('TC-8/TC-9 — the detail response carries this merchant’s own activity, and no budget or other participant’s data', async () => {
    const response = await get('merchantA', `/merchant/campaigns/${String(campActiveId)}`);
    expect(response.status).toBe(200);
    const detail = response.body.data as Record<string, unknown>;

    expect(detail.description).toBe('The active one');
    expect(detail.maxParticipants).toBe(50);
    expect(detail).toHaveProperty('participation');
    expect((detail.participation as { status: string }).status).toBe('active');

    const activities = detail.myActivities as { activityId: number; commissionRate: string }[];
    expect(activities).toHaveLength(1);
    expect(activities[0].activityId).toBe(activityAId);
    expect(activities[0].commissionRate).toBe('2.50');

    const serialised = JSON.stringify(detail);
    expect(serialised).not.toContain('budgetAmount');
    expect(serialised).not.toContain('budgetCurrency');
    expect(serialised).not.toContain('9.99'); // merchant B's own commission rate
    expect(serialised.includes(String(activityBId))).toBe(false);
  });

  it('TC-3 — a campaign this merchant does not participate in 404s', async () => {
    const response = await get('merchantA', `/merchant/campaigns/${String(campBOnlyId)}`);
    expect(response.status).toBe(404);
  });

  it('TC-4 — a campaign in another tenant 404s', async () => {
    const response = await get('merchantA', `/merchant/campaigns/${String(campCrossTenantId)}`);
    expect(response.status).toBe(404);
  });

  it('TC-5/TC-6 — a draft or pending_approval campaign this merchant is listed on 404s', async () => {
    const draft = await get('merchantA', `/merchant/campaigns/${String(campDraftId)}`);
    const pending = await get('merchantA', `/merchant/campaigns/${String(campPendingId)}`);
    expect(draft.status).toBe(404);
    expect(pending.status).toBe(404);
  });

  it('TC-14 — removing the merchant from campaign_merchants makes the campaign disappear', async () => {
    const before = await get('merchantA', '/merchant/campaigns');
    expect((before.body.data as { id: number }[]).map((row) => row.id)).toContain(campToRemoveId);

    await adminExec('DELETE FROM reward_config.campaign_merchants WHERE campaign_id = :id', {
      id: campToRemoveId,
    });

    const after = await get('merchantA', '/merchant/campaigns');
    expect((after.body.data as { id: number }[]).map((row) => row.id)).not.toContain(
      campToRemoveId,
    );
    const detail = await get('merchantA', `/merchant/campaigns/${String(campToRemoveId)}`);
    expect(detail.status).toBe(404);
  });
});

describe('GET /merchant/summary', () => {
  it('TC-13/TC-18 — counts match a direct SQL count for this merchant', async () => {
    const [{ count: activeCount }] = await sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_config.tenant_campaigns tc
        WHERE tc.tenant_id = :tenantId AND tc.status = 'active'
          AND EXISTS (SELECT 1 FROM reward_config.campaign_merchants cm
                       WHERE cm.campaign_id = tc.id AND cm.merchant_id = :merchantId
                         AND cm.status = 'active')`,
      { tenantId: tenantAId, merchantId: merchantAId },
    );
    const [{ count: activityCount }] = await sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_config.merchant_activities
        WHERE merchant_id = :merchantId AND status = 'active'`,
      { merchantId: merchantAId },
    );

    const response = await get('merchantA', '/merchant/summary');
    expect(response.status).toBe(200);
    expect(response.body.data.activeCampaignsCount).toBe(Number(activeCount));
    expect(response.body.data.myActivitiesCount).toBe(Number(activityCount));
  });

  it('TC-19 — an honest "not available" performance state, never a fabricated number', async () => {
    const response = await get('merchantA', '/merchant/summary');
    expect(response.body.data.campaignPerformance).toEqual({
      available: false,
      reason: expect.any(String),
    });
  });

  it('a maker calling this merchant-only surface gets 403', async () => {
    const response = await get('makerA', '/merchant/summary');
    expect(response.status).toBe(403);
  });
});

describe('No write surface at all (implementation note 3, TC-10/TC-11/TC-12)', () => {
  it('TC-10 — POST /merchant/campaigns does not exist', async () => {
    const response = await post('merchantA', '/merchant/campaigns', {});
    expect([404, 405]).toContain(response.status);
  });

  it('TC-11 — a merchant calling POST /campaigns gets 403', async () => {
    const response = await post('merchantA', '/campaigns', {
      name: 'should never be created',
      startDate: new Date().toISOString(),
      endDate: new Date().toISOString(),
    });
    expect(response.status).toBe(403);
  });

  it('TC-12 — a merchant calling PATCH on any campaign gets 403', async () => {
    const response = await patch('merchantA', `/campaigns/${String(campActiveId)}`, {
      name: 'should never be applied',
    });
    expect(response.status).toBe(403);
  });
});
