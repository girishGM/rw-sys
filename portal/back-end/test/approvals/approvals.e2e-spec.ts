/**
 * T-038 — `/approvals` against the **real** Postgres instance, through the real `AppModule`, over
 * real HTTP, as every role.
 *
 * Follows the harness `test/campaigns/campaigns.e2e-spec.ts` (T-037) establishes — real login
 * (through MFA for `super_admin`, T-055), real cookies, real guards, real `ScopedRepository`
 * scoping, real transactions, real row locks. Nothing is stubbed except the one deliberate
 * mid-transaction failure TC-16 requires, which is a spy on a real service instance rather than a
 * fake container.
 *
 * ### Why nearly all of this task is proved here
 *
 * Because what T-038 promises is almost entirely *"the database really refused that"*:
 *
 *  - **TC-6** is a claim about two rows and one integer comparison in a running service — a unit
 *    test with a fake repository would pass whether or not the check ran before the write.
 *  - **TC-15** is a claim about `SELECT … FOR UPDATE` under genuine concurrency. It cannot be
 *    simulated: two HTTP requests are fired at the same server, in the same millisecond, and the
 *    assertion is on what Postgres did with them.
 *  - **TC-16** is a claim about transaction rollback across two schemas.
 *
 * TC-6 and TC-15 are the two the task file says must not ship broken, and both are here.
 *
 * ### How the "user who holds both duties" scenario (TC-6) is built
 *
 * It is built **honestly**, not by editing `requested_by`. A user is created as a `maker`, builds
 * and submits a campaign for real through the wizard's own API, and is then promoted to `checker`
 * with a single `UPDATE portal_users SET role = 'checker'` and a fresh login. That is exactly the
 * situation implementation note 2 describes — *"even a user who legitimately holds both maker and
 * checker duties cannot approve their own work"* — reproduced rather than approximated. The
 * approval request itself is untouched: `requested_by` is whatever the real submit wrote.
 *
 * ### Isolation from the live data
 *
 * Every fixture is prefixed `T038E2E`, every campaign this suite creates is recorded and torn down
 * in `afterAll`, and no assertion counts rows globally. Countries `W1`/`W2` are this suite's own,
 * distinct from T-037's `S1`/`S2`, so the two suites cannot see each other's tenants. Teardown
 * uses `createMigrationConnection()` for the reason T-037's own header explains at length:
 * `reward_app` holds `SELECT, INSERT` and nothing else on the audit table, by design.
 */
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
import { CampaignAuditService } from '@/modules/campaigns/campaign-audit.service';
import { ApprovalsRepository } from '@/modules/approvals/approvals.repository';
import { loginCompletingMfa } from '../auth/support/super-admin-mfa';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import {
  clearProvidedKeyMaterial,
  provideMissingKeyMaterial,
} from '../campaigns/support/foreign-key-material';

jest.setTimeout(600_000);

const SUITE = 't038';
const PASSWORD = 'correct horse battery staple 7!';
const COUNTRY_A_CODE = 'W1';
const COUNTRY_B_CODE = 'W2';
const PREFIX = 'T038E2E';
const DISPLAY_PREFIX = 'T-038 ';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

let countryA: number;
let countryB: number;
let tenantA: number;
let tenantB: number;
let adminUserId: number;

/** Everything one tenant needs to build a submittable campaign. Two of these exist, so tenant B
 * can raise a real submission of its own — which is what makes TC-1's "only own-tenant rows" and
 * TC-4's 404 say anything at all. */
interface TenantFixtures {
  merchantId: number;
  activityId: number;
  ruleId: number;
  rewardPolicyId: number;
}
let fixturesA: TenantFixtures;
let fixturesB: TenantFixtures;

const createdCampaignIds = new Set<number>();
let borrowedKeyVars: string[] = [];

interface Actor {
  readonly email: string;
  readonly userId: number;
  readonly jar: string;
  readonly csrf: string;
}
const actors = new Map<string, Actor>();

// --- plumbing ------------------------------------------------------------------------------------

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

async function loginAs(key: string, email: string, userId: number): Promise<Actor> {
  const response = await loginCompletingMfa(app, { email, password: PASSWORD }, db);
  if (response.status !== 200) {
    throw new Error(`login for ${key} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  const actor: Actor = {
    email,
    userId,
    jar: jarFrom(response),
    csrf: cookieValue(response, CSRF_COOKIE_NAME),
  };
  actors.set(key, actor);
  return actor;
}

async function makeActor(
  key: string,
  role: PortalRole,
  scope: { countryId: number | null; tenantId: number | null; merchantId: number | null },
): Promise<Actor> {
  const email = `t038-e2e-${key}@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `${DISPLAY_PREFIX}${key}`,
    role,
    ...scope,
    mustChangePassword: false,
  });
  await exec(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
  );

  return loginAs(key, email, userId);
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
function patch(key: string, path: string, body: unknown) {
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
     VALUES (:code, :name, 'Asia/Kuala_Lumpur', 'MYR', '+060', 'active') RETURNING id`,
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

async function ensureActivity(code: string, tenantId: number): Promise<number> {
  const [type] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.activity_types ORDER BY id LIMIT 1',
  );
  if (type === undefined) throw new Error('no activity_types rows — is the schema seeded?');

  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.activities WHERE tenant_id = :tenantId AND activity_code = :code',
    { tenantId, code },
  );
  if (existing !== undefined) return existing.id;
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.activities (tenant_id, type_id, activity_code, name, status)
     VALUES (:tenantId, :typeId, :code, :code, 'active') RETURNING id`,
    { tenantId, typeId: type.id, code },
  );
  return created.id;
}

async function linkMerchantActivity(merchantId: number, activityId: number, tenantId: number) {
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.merchant_activities
      WHERE merchant_id = :merchantId AND activity_id = :activityId AND store_id IS NULL`,
    { merchantId, activityId },
  );
  if (existing !== undefined) return;
  await exec(
    `INSERT INTO reward_config.merchant_activities (tenant_id, merchant_id, activity_id, status)
     VALUES (:tenantId, :merchantId, :activityId, 'active')`,
    { tenantId, merchantId, activityId },
  );
}

const RULE_PARAMETERS = JSON.stringify({
  fields: [
    { key: 'minSpend', label: 'Minimum spend', type: 'number', required: true, min: 10, max: 5000 },
  ],
});

async function ensureAdminUserId(): Promise<number> {
  const [row] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.admin_users ORDER BY id LIMIT 1',
  );
  if (row === undefined) throw new Error('no admin_users rows — cannot author fixture versions');
  return row.id;
}

async function ensureRule(code: string, countryId: number): Promise<number> {
  const [subCategory] = await sql<{ id: number }>(
    `SELECT rsc.id FROM reward_config.rule_sub_categories rsc
       JOIN reward_config.rule_categories rc ON rc.id = rsc.category_id
      WHERE rc.category_code = 'TRANSACTION' AND rsc.sub_category_code = 'GENERAL' LIMIT 1`,
  );
  if (subCategory === undefined) throw new Error('seeded rule_sub_categories row not found');

  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.rule_master WHERE rule_code = :code',
    { code },
  );
  const ruleId =
    existing?.id ??
    (
      await sql<{ id: number }>(
        `INSERT INTO reward_config.rule_master
           (tenant_id, sub_category_id, rule_code, name, parameters, status)
         VALUES (NULL, :subCategoryId, :code, :code, :parameters, 'active') RETURNING id`,
        { subCategoryId: subCategory.id, code, parameters: RULE_PARAMETERS },
      )
    )[0].id;

  await exec(
    `UPDATE reward_config.rule_master SET parameters = :parameters, status = 'active' WHERE id = :id`,
    { id: ruleId, parameters: RULE_PARAMETERS },
  );

  const [assigned] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.rule_country_assignments WHERE rule_id = :ruleId AND country_id = :countryId',
    { ruleId, countryId },
  );
  if (assigned === undefined) {
    await exec(
      `INSERT INTO reward_config.rule_country_assignments (rule_id, country_id, assigned_by)
       VALUES (:ruleId, :countryId, :adminUserId)`,
      { ruleId, countryId, adminUserId },
    );
  }
  return ruleId;
}

async function ensureRewardPolicy(code: string, countryId: number): Promise<number> {
  const [existingSystem] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.reward_systems WHERE system_code = :code',
    { code },
  );
  const rewardId =
    existingSystem?.id ??
    (
      await sql<{ id: number }>(
        `INSERT INTO reward_config.reward_systems
           (tenant_id, system_code, name, reward_type, connector_type, status)
         VALUES (NULL, :code, :code, 'cashback', 'internal', 'active') RETURNING id`,
        { code },
      )
    )[0].id;

  const [countryAssignment] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.reward_country_assignments WHERE reward_id = :rewardId AND country_id = :countryId',
    { rewardId, countryId },
  );
  if (countryAssignment === undefined) {
    await exec(
      `INSERT INTO reward_config.reward_country_assignments (reward_id, country_id, assigned_by)
       VALUES (:rewardId, :countryId, :adminUserId)`,
      { rewardId, countryId, adminUserId },
    );
  }

  const [existingVersion] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.reward_versions WHERE reward_id = :rewardId AND version_no = 1',
    { rewardId },
  );
  const versionId =
    existingVersion?.id ??
    (
      await sql<{ id: number }>(
        `INSERT INTO reward_config.reward_versions
           (reward_id, version_no, unit_type, unit_code, status, created_by, published_by, published_at)
         VALUES (:rewardId, 1, 'currency', 'MYR', 'published', :adminUserId, :adminUserId, now())
         RETURNING id`,
        { rewardId, adminUserId },
      )
    )[0].id;

  const [versionAssignment] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.reward_version_country_assignments
      WHERE reward_version_id = :versionId AND country_id = :countryId`,
    { versionId, countryId },
  );
  if (versionAssignment === undefined) {
    await exec(
      `INSERT INTO reward_config.reward_version_country_assignments
         (reward_version_id, reward_id, country_id, status, assigned_by)
       VALUES (:versionId, :rewardId, :countryId, 'active', :adminUserId)`,
      { versionId, rewardId, countryId, adminUserId },
    );
  }

  const [policy] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.reward_policies WHERE reward_system_id = :rewardId AND policy_code = :code',
    { rewardId, code: `${code}_POL` },
  );
  if (policy !== undefined) return policy.id;
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.reward_policies (reward_system_id, policy_code, name, config, status)
     VALUES (:rewardId, :code, :code, :config, 'active') RETURNING id`,
    { rewardId, code: `${code}_POL`, config: JSON.stringify({ amount: '10.00' }) },
  );
  return created.id;
}

async function buildTenantFixtures(
  suffix: string,
  tenantId: number,
  countryId: number,
  countryCode: string,
): Promise<TenantFixtures> {
  const merchantId = await ensureMerchant(`${PREFIX}_M_${suffix}`, tenantId, countryCode);
  const activityId = await ensureActivity(`${PREFIX}_ACT_${suffix}`, tenantId);
  await linkMerchantActivity(merchantId, activityId, tenantId);
  return {
    merchantId,
    activityId,
    ruleId: await ensureRule(`${PREFIX}_RULE_${suffix}`, countryId),
    rewardPolicyId: await ensureRewardPolicy(`${PREFIX}_RWD_${suffix}`, countryId),
  };
}

/** Removes anything a previous, failed run of **this** suite left behind. Keyed strictly on this
 * suite's own `T038E2E` prefix and `T-038 ` display names. */
async function purgeSuiteResidue(): Promise<void> {
  const admin = createMigrationConnection();
  // Sequelize's `DatabaseError` carries the driver detail on nested properties rather than in
  // `message`, and a bare failure here reads as an empty jest error — which is exactly what makes
  // a broken teardown expensive to diagnose. Re-throwing with the statement and the driver's own
  // `detail`/`constraint` costs nothing and turns "beforeAll failed" into a sentence.
  const purge = async (statement: string) => {
    try {
      await admin.query(statement, { type: QueryTypes.RAW });
    } catch (error) {
      const cause = error as { message?: string; parent?: { message?: string; detail?: string } };
      throw new Error(
        `purge failed: ${statement.trim().slice(0, 120)} — ` +
          `${cause.parent?.message ?? cause.message ?? 'unknown'} ${cause.parent?.detail ?? ''}`,
      );
    }
  };
  try {
    const mine = `SELECT id FROM reward_config.tenant_campaigns WHERE campaign_code LIKE '${PREFIX}%'`;
    const myUsers = `SELECT id FROM reward_portal.portal_users WHERE display_name LIKE '${DISPLAY_PREFIX}%'`;

    // Both of these are keyed on the **actor** as well as on the campaign, and that second key is
    // not belt-and-braces: `fk_par_requested_by` and `fk_pcat_performed_by` are `ON DELETE
    // RESTRICT` (T037_001/T037_002 — audit rows are deliberately undeletable), so a row this
    // suite's own user raised against a campaign that is already gone makes the user itself
    // undeletable and every subsequent run fail on `uq_portal_users_email_live`. Observed, not
    // theorised: a crashed run left exactly that behind while this suite was being written.
    await purge(
      `DELETE FROM reward_portal.portal_campaign_audit_trail
        WHERE campaign_id IN (${mine}) OR performed_by IN (${myUsers})`,
    );
    await purge(
      `DELETE FROM reward_portal.portal_approval_requests
        WHERE (entity_type = 'campaign' AND entity_id IN (${mine}))
           OR requested_by IN (${myUsers})
           OR reviewed_by IN (${myUsers})`,
    );
    for (const table of [
      'reward_config.campaign_caps',
      'reward_config.reward_campaign_assignments',
      'reward_config.campaign_merchants',
    ]) {
      await purge(`DELETE FROM ${table} WHERE campaign_id IN (${mine})`);
    }
    await purge(
      `DELETE FROM reward_config.tracker_component_rules
        WHERE tracker_component_id IN (
          SELECT ttc.component_id FROM reward_config.tracker_tracker_components ttc
           WHERE ttc.tracker_id IN (
             SELECT tracker_id FROM reward_config.tenant_campaign_trackers
              WHERE campaign_id IN (${mine})))`,
    );
    await purge(
      `DELETE FROM reward_config.reward_component_assignments
        WHERE component_id IN (
          SELECT ttc.component_id FROM reward_config.tracker_tracker_components ttc
           WHERE ttc.tracker_id IN (
             SELECT tracker_id FROM reward_config.tenant_campaign_trackers
              WHERE campaign_id IN (${mine})))`,
    );
    await purge(
      `DELETE FROM reward_config.tracker_tracker_components
        WHERE tracker_id IN (
          SELECT tracker_id FROM reward_config.tenant_campaign_trackers
           WHERE campaign_id IN (${mine}))`,
    );
    await purge(
      `DELETE FROM reward_config.tenant_campaign_trackers WHERE campaign_id IN (${mine})`,
    );
    await purge(`DELETE FROM reward_config.tenant_campaigns WHERE campaign_code LIKE '${PREFIX}%'`);
    await purge(`
      DELETE FROM reward_portal.portal_user_notifications
       WHERE user_id IN (SELECT id FROM reward_portal.portal_users
                          WHERE display_name LIKE '${DISPLAY_PREFIX}%')`);
    await purge(
      `DELETE FROM reward_portal.portal_users WHERE display_name LIKE '${DISPLAY_PREFIX}%'`,
    );
  } finally {
    await admin.close();
  }
}

// --- campaign-building helpers ------------------------------------------------------------------

let codeCounter = 0;
function campaignCode(): string {
  codeCounter += 1;
  return `${PREFIX}_${String(Date.now())}_${String(codeCounter)}`.slice(0, 50);
}

function inDays(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000);
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * Several maker and checker accounts, rotated per test.
 *
 * T-012's general throttle is 300 authenticated requests per user per minute, keyed by user id.
 * Building one submittable campaign costs six requests, so a single maker would start collecting
 * 429s partway through — the rate limiter working as designed, not a bug to route around.
 * Spreading the load raises no limit and exempts no route; campaign scope is the *tenant*, not the
 * author, so the rotation is transparent to every assertion that is not about identity.
 */
const MAKER_POOL = ['makerA1', 'makerA2', 'makerA3', 'makerA4', 'makerA5', 'makerA6'] as const;
let makerCursor = 0;
function nextMaker(): string {
  makerCursor += 1;
  return MAKER_POOL[makerCursor % MAKER_POOL.length];
}

interface Submitted {
  readonly campaignId: number;
  readonly requestId: number;
  readonly makerKey: string;
  readonly code: string;
}

/** A complete campaign, submitted for real through the wizard's own API. Returns the approval
 * request the submit created. */
async function submitCampaign(
  makerKey: string = nextMaker(),
  fixtures: TenantFixtures = fixturesA,
): Promise<Submitted> {
  const code = campaignCode();
  const created = await post(makerKey, '/campaigns', {
    campaignCode: code,
    name: 'T-038 e2e campaign',
    startDate: inDays(1),
    endDate: inDays(30),
    budgetAmount: '1000.00',
    budgetCurrency: 'MYR',
  });
  if (created.status !== 201) {
    throw new Error(`create failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  const campaignId = created.body.data.id as number;
  createdCampaignIds.add(campaignId);

  await post(makerKey, `/campaigns/${String(campaignId)}/merchants`, {
    merchantIds: [fixtures.merchantId],
  }).expect(201);
  const tracker = await post(makerKey, `/campaigns/${String(campaignId)}/trackers`, {
    name: 'Onboarding',
    completionLogic: 'all',
  }).expect(201);
  const trackerId = tracker.body.data.trackers[0].id as number;

  const withComponent = await post(
    makerKey,
    `/campaigns/${String(campaignId)}/trackers/${String(trackerId)}/components`,
    { name: 'First purchase', activityId: fixtures.activityId },
  ).expect(201);
  const componentId = withComponent.body.data.trackers[0].components[0].id as number;

  await post(makerKey, `/campaigns/${String(campaignId)}/rules`, {
    componentId,
    ruleId: fixtures.ruleId,
    values: { minSpend: 50 },
  }).expect(201);
  await post(makerKey, `/campaigns/${String(campaignId)}/rewards`, {
    level: 'campaign',
    rewardPolicyId: fixtures.rewardPolicyId,
  }).expect(201);

  const submitted = await post(makerKey, `/campaigns/${String(campaignId)}/submit`);
  if (submitted.status !== 200) {
    throw new Error(`submit failed: ${submitted.status} ${JSON.stringify(submitted.body)}`);
  }

  return {
    campaignId,
    requestId: submitted.body.data.approvalRequestId as number,
    makerKey,
    code,
  };
}

async function campaignRow(id: number) {
  const [row] = await sql<{
    status: string;
    approved_by: string | null;
    approved_at: Date | null;
  }>('SELECT status, approved_by, approved_at FROM reward_config.tenant_campaigns WHERE id = :id', {
    id,
  });
  return row;
}

async function requestRow(id: number) {
  const [row] = await sql<{
    status: string;
    reviewed_by: number | null;
    reviewed_at: Date | null;
    review_comment: string | null;
  }>(
    `SELECT status, reviewed_by, reviewed_at, review_comment
       FROM reward_portal.portal_approval_requests WHERE id = :id`,
    { id },
  );
  return row;
}

async function auditRows(campaignId: number, action: string) {
  return sql<{ id: number; approval_request_id: number | null; entity_type: string }>(
    `SELECT id, approval_request_id, entity_type
       FROM reward_portal.portal_campaign_audit_trail
      WHERE campaign_id = :campaignId AND action = :action`,
    { campaignId, action },
  );
}

async function notificationsFor(userId: number, type: string) {
  return sql<{ id: number; title: string; message: string; entity_id: number | null }>(
    `SELECT id, title, message, entity_id FROM reward_portal.portal_user_notifications
      WHERE user_id = :userId AND notification_type = :type ORDER BY id DESC`,
    { userId, type },
  );
}

// --- lifecycle -----------------------------------------------------------------------------------

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), SUITE);
  borrowedKeyVars = await provideMissingKeyMaterial(moduleRef.get<Sequelize>(SEQUELIZE));

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
  emailCrypto = emailCryptoOf(app);

  await purgeSuiteResidue();

  adminUserId = await ensureAdminUserId();
  countryA = await ensureCountry(COUNTRY_A_CODE, 'T-038 e2e country A');
  countryB = await ensureCountry(COUNTRY_B_CODE, 'T-038 e2e country B');
  tenantA = await ensureTenant(`${PREFIX}_TENANT_A`, countryA);
  tenantB = await ensureTenant(`${PREFIX}_TENANT_B`, countryB);
  fixturesA = await buildTenantFixtures('A', tenantA, countryA, COUNTRY_A_CODE);
  fixturesB = await buildTenantFixtures('B', tenantB, countryB, COUNTRY_B_CODE);

  await makeActor('super', 'super_admin', { countryId: null, tenantId: null, merchantId: null });
  await makeActor('countryAdminA', 'country_admin', {
    countryId: countryA,
    tenantId: null,
    merchantId: null,
  });
  await makeActor('tenantAdminA', 'tenant_admin', {
    countryId: countryA,
    tenantId: tenantA,
    merchantId: null,
  });
  for (const key of MAKER_POOL) {
    await makeActor(key, 'maker', { countryId: countryA, tenantId: tenantA, merchantId: null });
  }
  for (const key of ['checkerA1', 'checkerA2', 'checkerA3']) {
    await makeActor(key, 'checker', { countryId: countryA, tenantId: tenantA, merchantId: null });
  }
  await makeActor('merchantA', 'merchant', {
    countryId: countryA,
    tenantId: tenantA,
    merchantId: fixturesA.merchantId,
  });
  await makeActor('makerB', 'maker', { countryId: countryB, tenantId: tenantB, merchantId: null });
  await makeActor('checkerB', 'checker', {
    countryId: countryB,
    tenantId: tenantB,
    merchantId: null,
  });
  // The "holds both duties" account (TC-6). Created as a maker; promoted to checker in its own
  // test, after it has submitted something for real.
  await makeActor('dualRole', 'maker', {
    countryId: countryA,
    tenantId: tenantA,
    merchantId: null,
  });
});

/**
 * Teardown, in a `try`/`finally` whose `finally` closes the application.
 *
 * The nesting is not decoration. Nest keeps the process alive while an application is open — the
 * Sequelize pool and this module's own hourly `@Cron` are both live handles — so a teardown that
 * throws before `app.close()` does not merely leave rows behind: **jest never exits**, with no
 * failing assertion and no output, for as long as anyone is willing to wait. That is exactly what
 * happened while this suite was being written (the diff-view block leaves an approval request whose
 * `entity_type` it deliberately corrupted, which made the old `entity_type = 'campaign'` purge miss
 * it and the user delete fail on `fk_par_requested_by`). Closing in a `finally` turns that class of
 * bug back into an ordinary red test.
 */
afterAll(async () => {
  try {
    await teardown();
  } finally {
    clearProvidedKeyMaterial(borrowedKeyVars);
    if (app !== undefined) await app.close();
  }
});

async function teardown(): Promise<void> {
  if (db !== undefined) {
    const admin = createMigrationConnection();
    const purge = async (statement: string, replacements: Record<string, unknown> = {}) => {
      await admin.query(statement, { type: QueryTypes.RAW, replacements });
    };

    try {
      const ids = [...createdCampaignIds];
      if (ids.length > 0) {
        await purge(
          'DELETE FROM reward_portal.portal_campaign_audit_trail WHERE campaign_id IN (:ids)',
          { ids },
        );
        // Deliberately **not** filtered on `entity_type`: the diff-view block rewrites one row's
        // `entity_type` to prove the unsupported-subject refusal, and a purge that trusted that
        // column would leave it behind — see this function's own header for what that costs.
        await purge(
          'DELETE FROM reward_portal.portal_approval_requests WHERE entity_id IN (:ids)',
          {
            ids,
          },
        );
        await purge('DELETE FROM reward_config.campaign_caps WHERE campaign_id IN (:ids)', { ids });
        await purge(
          'DELETE FROM reward_config.reward_campaign_assignments WHERE campaign_id IN (:ids)',
          { ids },
        );
        await purge(
          `DELETE FROM reward_config.reward_component_assignments
            WHERE component_id IN (
              SELECT ttc.component_id FROM reward_config.tracker_tracker_components ttc
               WHERE ttc.tracker_id IN (
                 SELECT tracker_id FROM reward_config.tenant_campaign_trackers
                  WHERE campaign_id IN (:ids)))`,
          { ids },
        );
        await purge(
          `DELETE FROM reward_config.tracker_component_rules
            WHERE tracker_component_id IN (
              SELECT ttc.component_id FROM reward_config.tracker_tracker_components ttc
               WHERE ttc.tracker_id IN (
                 SELECT tracker_id FROM reward_config.tenant_campaign_trackers
                  WHERE campaign_id IN (:ids)))`,
          { ids },
        );
        await purge(
          `DELETE FROM reward_config.tracker_tracker_components
            WHERE tracker_id IN (
              SELECT tracker_id FROM reward_config.tenant_campaign_trackers
               WHERE campaign_id IN (:ids))`,
          { ids },
        );
        await purge(
          'DELETE FROM reward_config.tenant_campaign_trackers WHERE campaign_id IN (:ids)',
          { ids },
        );
        await purge('DELETE FROM reward_config.campaign_merchants WHERE campaign_id IN (:ids)', {
          ids,
        });
        await purge('DELETE FROM reward_config.tenant_campaigns WHERE id IN (:ids)', { ids });
      }
      for (const actor of actors.values()) {
        await purge('DELETE FROM reward_portal.portal_user_notifications WHERE user_id = :id', {
          id: actor.userId,
        });
        // The two `ON DELETE RESTRICT` parents, cleared by actor as well as by campaign — the
        // same reason `purgeSuiteResidue` gives.
        await purge(
          `DELETE FROM reward_portal.portal_approval_requests
            WHERE requested_by = :id OR reviewed_by = :id`,
          { id: actor.userId },
        );
        await purge(
          'DELETE FROM reward_portal.portal_campaign_audit_trail WHERE performed_by = :id',
          { id: actor.userId },
        );
        await purge('DELETE FROM reward_portal.portal_users WHERE id = :id', { id: actor.userId });
      }
      await removeEncryptionKeys(db, SUITE);
    } finally {
      await admin.close();
    }
  }
}

// --- TC-1…TC-4: the queue and who can see it -----------------------------------------------------

describe('T-038 · the queue', () => {
  it('TC-1: a checker lists the queue and sees only their own tenant’s requests', async () => {
    const mine = await submitCampaign();
    const theirs = await submitCampaign('makerB', fixturesB);

    const response = await get('checkerA1', '/approvals?pageSize=100').expect(200);
    const ids = (response.body.data as { id: number }[]).map((row) => row.id);

    expect(ids).toContain(mine.requestId);
    expect(ids).not.toContain(theirs.requestId);
    // Scope, not a role branch: every row that came back is tenant A's.
    for (const row of response.body.data as { tenantId: number }[]) {
      expect(row.tenantId).toBe(tenantA);
    }
  });

  it('TC-1: the queue resolves the campaign so a checker never sees a bare id', async () => {
    const submitted = await submitCampaign();

    const response = await get('checkerA1', '/approvals?pageSize=100').expect(200);
    const row = (response.body.data as { id: number; subject: unknown }[]).find(
      (entry) => entry.id === submitted.requestId,
    );

    expect(row?.subject).toMatchObject({
      campaignId: submitted.campaignId,
      campaignCode: submitted.code,
      campaignStatus: 'pending_approval',
    });
  });

  it('TC-2: a maker gets a read-only view — the same rows, none of them decidable', async () => {
    const submitted = await submitCampaign('makerA1');

    const response = await get('makerA2', '/approvals?pageSize=100').expect(200);
    const row = (
      response.body.data as { id: number; decidable: boolean; actionable: boolean }[]
    ).find((entry) => entry.id === submitted.requestId);

    expect(row).toBeDefined();
    expect(row?.actionable).toBe(true);
    // The button state the SPA renders from. The server refuses regardless — see TC-17.
    expect(row?.decidable).toBe(false);
  });

  it.each(['super', 'countryAdminA', 'tenantAdminA'])(
    'TC-2: %s may read the queue but nothing in it is decidable',
    async (key) => {
      const response = await get(key, '/approvals?pageSize=100').expect(200);
      for (const row of response.body.data as { decidable: boolean }[]) {
        expect(row.decidable).toBe(false);
      }
    },
  );

  it('TC-3: a merchant calling /approvals gets 403 — there is no approval permission row for them', async () => {
    await get('merchantA', '/approvals').expect(403);
    await get('merchantA', '/approvals/1').expect(403);
  });

  it('TC-4: a checker in tenant B reading tenant A’s request gets 404, not 403', async () => {
    const mine = await submitCampaign();

    await get('checkerB', `/approvals/${String(mine.requestId)}`).expect(404);
    // And the decision routes are equally blind to it.
    await post('checkerB', `/approvals/${String(mine.requestId)}/approve`).expect(404);
  });

  it('TC-24: a queue of 200 pending requests paginates', async () => {
    const anchor = await submitCampaign();
    const requestedBy = as(anchor.makerKey).userId;

    // 200 rows against one real campaign. This test is about the pager, not about 200 campaigns —
    // building those for real would cost 1,200 HTTP calls and prove nothing extra.
    await exec(
      `INSERT INTO reward_portal.portal_approval_requests
         (tenant_id, entity_type, entity_id, action, status, payload, requested_by, requested_at,
          expires_at)
       SELECT :tenantId, 'campaign', :campaignId, 'create', 'pending', '{}'::jsonb, :requestedBy,
              now(), now() + interval '7 days'
         FROM generate_series(1, 200)`,
      { tenantId: tenantA, campaignId: anchor.campaignId, requestedBy },
    );

    const firstPage = await get('checkerA1', '/approvals?status=pending&pageSize=50').expect(200);
    expect(firstPage.body.data).toHaveLength(50);
    expect(firstPage.body.meta.total).toBeGreaterThanOrEqual(200);

    const secondPage = await get(
      'checkerA1',
      '/approvals?status=pending&pageSize=50&page=2',
    ).expect(200);
    expect(secondPage.body.data).toHaveLength(50);

    const firstIds = new Set((firstPage.body.data as { id: number }[]).map((row) => row.id));
    for (const row of secondPage.body.data as { id: number }[]) {
      // A stable total order — `requested_at DESC, id DESC` — so no row appears on two pages.
      expect(firstIds.has(row.id)).toBe(false);
    }

    // `pageSize` is capped, not rejected (03-API-CONTRACT.md §1).
    const capped = await get('checkerA1', '/approvals?pageSize=5000').expect(200);
    expect((capped.body.data as unknown[]).length).toBeLessThanOrEqual(100);
  });
});

// --- TC-5, TC-21, TC-23: the happy path ----------------------------------------------------------

describe('T-038 · approve', () => {
  it('TC-5/TC-21/TC-23: approval activates the campaign, stamps it, audits it and notifies the maker', async () => {
    const submitted = await submitCampaign();
    const checker = as('checkerA1');

    const response = await post('checkerA1', `/approvals/${String(submitted.requestId)}/approve`, {
      comment: 'Budget and journey both check out.',
    }).expect(200);

    expect(response.body.data.status).toBe('approved');
    expect(response.body.data.effectiveStatus).toBe('approved');
    expect(response.body.data.actionable).toBe(false);
    expect(response.body.data.reviewedBy).toBe(checker.userId);

    // Verification step 3 — the campaign row itself.
    const campaign = await campaignRow(submitted.campaignId);
    expect(campaign.status).toBe('active');
    expect(campaign.approved_by).toBe(String(checker.userId));
    expect(campaign.approved_at).not.toBeNull();

    const request = await requestRow(submitted.requestId);
    expect(request.status).toBe('approved');
    expect(request.reviewed_by).toBe(checker.userId);
    expect(request.reviewed_at).not.toBeNull();

    // TC-23 — `approved`, carrying the request id that justified it.
    const audit = await auditRows(submitted.campaignId, 'approved');
    expect(audit).toHaveLength(1);
    expect(audit[0].approval_request_id).toBe(submitted.requestId);
    expect(audit[0].entity_type).toBe('campaign_approval');

    // TC-21 — the maker, not the checker, is notified.
    const maker = as(submitted.makerKey);
    const notifications = await notificationsFor(maker.userId, 'campaign_approved');
    expect(notifications).toHaveLength(1);
    expect(notifications[0].entity_id).toBe(submitted.campaignId);
    expect(await notificationsFor(checker.userId, 'campaign_approved')).toHaveLength(0);
  });

  it('approves without a comment — agreeing with what the maker documented needs no essay', async () => {
    const submitted = await submitCampaign();

    await post('checkerA2', `/approvals/${String(submitted.requestId)}/approve`).expect(200);

    expect((await campaignRow(submitted.campaignId)).status).toBe('active');
    expect((await requestRow(submitted.requestId)).review_comment).toBeNull();
  });

  it('TC-12: approving an already-approved request is a 409, and changes nothing', async () => {
    const submitted = await submitCampaign();
    await post('checkerA1', `/approvals/${String(submitted.requestId)}/approve`).expect(200);

    const before = await requestRow(submitted.requestId);
    const second = await post(
      'checkerA2',
      `/approvals/${String(submitted.requestId)}/approve`,
    ).expect(409);

    expect(second.body.error.code).toBe('APPROVAL_ALREADY_DECIDED');
    expect(await requestRow(submitted.requestId)).toEqual(before);
    // Exactly one audit row, not two.
    expect(await auditRows(submitted.campaignId, 'approved')).toHaveLength(1);
  });
});

// --- TC-6: segregation of duty -------------------------------------------------------------------

describe('T-038 · TC-6 — segregation of duty is structural', () => {
  /**
   * Three real submissions raised **while the account was still a maker**, then one promotion.
   *
   * The order is the whole point: `campaign:submit` is a maker-only permission and
   * `CampaignsService.submit` asserts the role independently, so a checker cannot raise a
   * submission at all. Every submission has to exist before the promotion, and after it this
   * account is a checker looking at three requests it raised itself — precisely the situation
   * implementation note 2 describes and the only way to reach the 422 honestly.
   */
  const own: Submitted[] = [];

  beforeAll(async () => {
    for (let index = 0; index < 3; index += 1) {
      own.push(await submitCampaign('dualRole'));
    }

    const dual = as('dualRole');
    await exec(`UPDATE reward_portal.portal_users SET role = 'checker' WHERE id = :id`, {
      id: dual.userId,
    });
    // A fresh login: the role travels in the verified JWT, so the old session still says `maker`.
    await loginAs('dualRole', dual.email, dual.userId);
  });

  it('a user who holds BOTH maker and checker duties cannot approve their own submission', async () => {
    const submitted = own[0];

    // They hold every permission the endpoint requires…
    const queue = await get('dualRole', '/approvals?pageSize=100').expect(200);
    const row = (
      queue.body.data as { id: number; selfSubmitted: boolean; decidable: boolean }[]
    ).find((entry) => entry.id === submitted.requestId);
    expect(row?.selfSubmitted).toBe(true);
    expect(row?.decidable).toBe(false);

    // …and are still refused, with 422 rather than 403, because the permission is not what is
    // missing (see `approvals.errors.ts`).
    const response = await post(
      'dualRole',
      `/approvals/${String(submitted.requestId)}/approve`,
    ).expect(422);
    expect(response.body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');

    // "Nothing changed."
    const request = await requestRow(submitted.requestId);
    expect(request.status).toBe('pending');
    expect(request.reviewed_by).toBeNull();
    expect((await campaignRow(submitted.campaignId)).status).toBe('pending_approval');
    expect(await auditRows(submitted.campaignId, 'approved')).toHaveLength(0);
  });

  it('the same user cannot reject or return their own submission either — self-review is self-review', async () => {
    const submitted = own[1];

    const rejected = await post('dualRole', `/approvals/${String(submitted.requestId)}/reject`, {
      comment: 'Changed my mind.',
    }).expect(422);
    expect(rejected.body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');

    const returned = await post('dualRole', `/approvals/${String(submitted.requestId)}/return`, {
      comment: 'Changed my mind.',
    }).expect(422);
    expect(returned.body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');

    expect((await requestRow(submitted.requestId)).status).toBe('pending');
    expect((await campaignRow(submitted.campaignId)).status).toBe('pending_approval');
  });

  it('another checker in the same tenant approves the very same request without trouble', async () => {
    // The control is *"not this person"*, not *"nobody"* — a refusal that also blocked a
    // legitimate second checker would be a broken workflow rather than a governance control.
    const submitted = own[2];

    await post('checkerA3', `/approvals/${String(submitted.requestId)}/approve`).expect(200);

    expect((await campaignRow(submitted.campaignId)).status).toBe('active');
  });
});

// --- TC-7…TC-11: reject, return, and the comment rules --------------------------------------------

describe('T-038 · reject and return', () => {
  it('TC-7/TC-22: rejecting records the comment, sends the campaign back to draft and notifies the maker', async () => {
    const submitted = await submitCampaign();

    const response = await post('checkerA1', `/approvals/${String(submitted.requestId)}/reject`, {
      comment: 'The cashback ceiling is far too high for this segment.',
    }).expect(200);

    expect(response.body.data.status).toBe('rejected');
    expect(response.body.data.reviewComment).toBe(
      'The cashback ceiling is far too high for this segment.',
    );

    const request = await requestRow(submitted.requestId);
    expect(request.status).toBe('rejected');
    expect(request.review_comment).toBe('The cashback ceiling is far too high for this segment.');
    // `ck_tc_status` has no `rejected` value; the campaign lands on `draft` and the *request*
    // carries the decision — `campaign-state-machine.ts`'s header explains why.
    expect((await campaignRow(submitted.campaignId)).status).toBe('draft');
    expect(await auditRows(submitted.campaignId, 'rejected')).toHaveLength(1);

    const notifications = await notificationsFor(
      as(submitted.makerKey).userId,
      'campaign_rejected',
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toContain('far too high');
  });

  it('TC-9: returning sends the campaign back to the maker, who can edit it again', async () => {
    const submitted = await submitCampaign();

    await post('checkerA2', `/approvals/${String(submitted.requestId)}/return`, {
      comment: 'Please add a second tracker for the referral leg.',
    }).expect(200);

    expect((await requestRow(submitted.requestId)).status).toBe('returned');
    expect((await campaignRow(submitted.campaignId)).status).toBe('draft');

    // What the maker sees, and what they can do about it.
    const campaign = await get(
      submitted.makerKey,
      `/campaigns/${String(submitted.campaignId)}`,
    ).expect(200);
    expect(campaign.body.data.effectiveStatus).toBe('returned');
    expect(campaign.body.data.editable).toBe(true);
    expect(campaign.body.data.lastReviewComment).toContain('referral leg');

    await patch(submitted.makerKey, `/campaigns/${String(submitted.campaignId)}`, {
      name: 'T-038 e2e campaign (reworked)',
    }).expect(200);

    const notifications = await notificationsFor(
      as(submitted.makerKey).userId,
      'campaign_returned',
    );
    expect(notifications).toHaveLength(1);
  });

  it('TC-8/TC-10: reject and return without a comment are 400s', async () => {
    const submitted = await submitCampaign();

    for (const verb of ['reject', 'return']) {
      await post('checkerA1', `/approvals/${String(submitted.requestId)}/${verb}`, {}).expect(400);
      await post('checkerA1', `/approvals/${String(submitted.requestId)}/${verb}`, {
        comment: '',
      }).expect(400);
      // `.min(1)` alone would accept this; the shared schema's `.refine` does not.
      await post('checkerA1', `/approvals/${String(submitted.requestId)}/${verb}`, {
        comment: '     ',
      }).expect(400);
    }

    expect((await requestRow(submitted.requestId)).status).toBe('pending');
  });

  it('TC-11: a comment longer than 500 characters is a 400 on all three decisions', async () => {
    const submitted = await submitCampaign();
    const tooLong = 'x'.repeat(501);

    for (const verb of ['approve', 'reject', 'return']) {
      await post('checkerA1', `/approvals/${String(submitted.requestId)}/${verb}`, {
        comment: tooLong,
      }).expect(400);
    }
    // Exactly 500 is accepted — the bound is `varchar(500)`, restated once in the shared schema.
    await post('checkerA1', `/approvals/${String(submitted.requestId)}/approve`, {
      comment: 'y'.repeat(500),
    }).expect(200);
  });

  it('rejects an unexpected key in the body rather than ignoring it', async () => {
    const submitted = await submitCampaign();

    // R3 — a body that could name its own reviewer or tenant is a bug, not a feature.
    await post('checkerA1', `/approvals/${String(submitted.requestId)}/approve`, {
      comment: 'fine',
      reviewedBy: 1,
    }).expect(400);
    await post('checkerA1', `/approvals/${String(submitted.requestId)}/approve`, {
      comment: 'fine',
      tenantId: tenantB,
    }).expect(400);
  });
});

// --- TC-13, TC-14: expiry -------------------------------------------------------------------------

describe('T-038 · expiry', () => {
  it('TC-13: approving an expired request is a 409 APPROVAL_EXPIRED', async () => {
    const submitted = await submitCampaign();
    await exec(
      `UPDATE reward_portal.portal_approval_requests
          SET expires_at = now() - interval '1 hour' WHERE id = :id`,
      { id: submitted.requestId },
    );

    const response = await post(
      'checkerA1',
      `/approvals/${String(submitted.requestId)}/approve`,
    ).expect(409);

    expect(response.body.error.code).toBe('APPROVAL_EXPIRED');
    expect((await campaignRow(submitted.campaignId)).status).toBe('pending_approval');
  });

  it('TC-14: a stale row reads as expired before the sweeper has ever run', async () => {
    const submitted = await submitCampaign();
    await exec(
      `UPDATE reward_portal.portal_approval_requests
          SET expires_at = now() - interval '1 hour' WHERE id = :id`,
      { id: submitted.requestId },
    );

    // The stored value is still `pending` — nothing has swept it.
    expect((await requestRow(submitted.requestId)).status).toBe('pending');

    const response = await get('checkerA1', `/approvals/${String(submitted.requestId)}`).expect(
      200,
    );
    expect(response.body.data.request.status).toBe('pending');
    expect(response.body.data.request.effectiveStatus).toBe('expired');
    expect(response.body.data.request.actionable).toBe(false);
    expect(response.body.data.request.decidable).toBe(false);
  });

  it('the sweeper marks exactly the timed-out pending rows, and nothing else', async () => {
    const stale = await submitCampaign();
    const fresh = await submitCampaign();
    await exec(
      `UPDATE reward_portal.portal_approval_requests
          SET expires_at = now() - interval '1 hour' WHERE id = :id`,
      { id: stale.requestId },
    );

    await app.get(ApprovalsRepository).markExpired();

    expect((await requestRow(stale.requestId)).status).toBe('expired');
    expect((await requestRow(fresh.requestId)).status).toBe('pending');
    // And an already-decided row is never touched by the sweep.
    await post('checkerA1', `/approvals/${String(fresh.requestId)}/approve`).expect(200);
    await app.get(ApprovalsRepository).markExpired();
    expect((await requestRow(fresh.requestId)).status).toBe('approved');
  });
});

// --- TC-15: two checkers, one request -------------------------------------------------------------

describe('T-038 · TC-15 — concurrency', () => {
  it('two checkers approving simultaneously produce exactly one 200, one 409 and one audit row', async () => {
    const submitted = await submitCampaign();
    const path = `/approvals/${String(submitted.requestId)}/approve`;

    // Fired together, at the same server, in the same millisecond. `SELECT … FOR UPDATE` inside
    // the transaction is what makes this deterministic rather than a coin toss.
    const [first, second] = await Promise.all([post('checkerA1', path), post('checkerA2', path)]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const loser = first.status === 409 ? first : second;
    expect(loser.body.error.code).toBe('APPROVAL_ALREADY_DECIDED');

    // Activated once…
    expect((await campaignRow(submitted.campaignId)).status).toBe('active');
    // …and audited once. This is the assertion that would fail if the lock were absent.
    expect(await auditRows(submitted.campaignId, 'approved')).toHaveLength(1);

    const request = await requestRow(submitted.requestId);
    const winnerId = first.status === 200 ? as('checkerA1').userId : as('checkerA2').userId;
    expect(request.reviewed_by).toBe(winnerId);
  });

  it('three checkers racing still produce exactly one winner', async () => {
    const submitted = await submitCampaign();
    const path = `/approvals/${String(submitted.requestId)}/approve`;

    const responses = await Promise.all([
      post('checkerA1', path),
      post('checkerA2', path),
      post('checkerA3', path),
    ]);

    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(2);
    expect(await auditRows(submitted.campaignId, 'approved')).toHaveLength(1);
  });
});

// --- TC-16: all or nothing ------------------------------------------------------------------------

describe('T-038 · TC-16 — a mid-transaction failure leaves nothing half-done', () => {
  it('rolls the request AND the campaign back when the audit write fails', async () => {
    const submitted = await submitCampaign();

    // The audit row is written *inside* the decision transaction precisely so that this cannot
    // succeed halfway. Spying on the real singleton is the only way to reach the failure without
    // corrupting the schema.
    const auditService = app.get(CampaignAuditService);
    const spy = jest
      .spyOn(auditService, 'recordOrFail')
      .mockRejectedValueOnce(new Error('T-038 injected audit failure'));

    try {
      await post('checkerA1', `/approvals/${String(submitted.requestId)}/approve`).expect(500);
    } finally {
      spy.mockRestore();
    }

    const request = await requestRow(submitted.requestId);
    expect(request.status).toBe('pending');
    expect(request.reviewed_by).toBeNull();
    expect(request.reviewed_at).toBeNull();

    const campaign = await campaignRow(submitted.campaignId);
    expect(campaign.status).toBe('pending_approval');
    expect(campaign.approved_by).toBeNull();
    expect(campaign.approved_at).toBeNull();

    // And the request is still perfectly decidable afterwards — the rollback lost nothing.
    await post('checkerA1', `/approvals/${String(submitted.requestId)}/approve`).expect(200);
    expect((await campaignRow(submitted.campaignId)).status).toBe('active');
  });
});

// --- TC-17, TC-18: the wrong role, straight at the API --------------------------------------------

describe('T-038 · the wrong role gets nowhere', () => {
  it('TC-17: a maker calling approve directly gets 403', async () => {
    const submitted = await submitCampaign('makerA1');

    for (const verb of ['approve', 'reject', 'return']) {
      const response = await post('makerA2', `/approvals/${String(submitted.requestId)}/${verb}`, {
        comment: 'let me through',
      });
      expect(response.status).toBe(403);
    }
    expect((await requestRow(submitted.requestId)).status).toBe('pending');
  });

  it('TC-18: a tenant_admin calling approve gets 403', async () => {
    const submitted = await submitCampaign();

    for (const key of ['tenantAdminA', 'countryAdminA', 'super']) {
      const response = await post(key, `/approvals/${String(submitted.requestId)}/approve`);
      expect(response.status).toBe(403);
    }
    expect((await requestRow(submitted.requestId)).status).toBe('pending');
  });

  it('a merchant gets 403 on every decision route too', async () => {
    const submitted = await submitCampaign();

    for (const verb of ['approve', 'reject', 'return']) {
      await post('merchantA', `/approvals/${String(submitted.requestId)}/${verb}`, {
        comment: 'no',
      }).expect(403);
    }
  });
});

// --- TC-19, TC-20: the diff -----------------------------------------------------------------------

describe('T-038 · the diff view', () => {
  it('TC-19: shows before/after for changed fields only', async () => {
    const submitted = await submitCampaign();

    // Change the campaign underneath the submission, the way a `returned → edit → resubmit` cycle
    // or an out-of-band correction would.
    await exec(
      `UPDATE reward_config.tenant_campaigns SET name = 'Renamed after submission' WHERE id = :id`,
      { id: submitted.campaignId },
    );

    const response = await get('checkerA1', `/approvals/${String(submitted.requestId)}`).expect(
      200,
    );
    const diff = response.body.data.diff;

    expect(diff.renderable).toBe(true);
    expect(diff.problem).toBeNull();
    expect(diff.changed).toEqual([
      {
        field: 'name',
        label: 'Name',
        before: 'T-038 e2e campaign',
        after: 'Renamed after submission',
      },
    ]);
    expect(diff.unchangedCount).toBe(3);
    // T-037's payload context, carried through for the checker.
    expect(diff.trackerCount).toBe(1);
    expect(diff.componentCount).toBe(1);
  });

  it('TC-20: a malformed payload renders a readable fallback, and the queue stays usable', async () => {
    const submitted = await submitCampaign();
    await exec(
      `UPDATE reward_portal.portal_approval_requests SET payload = '"not an object"'::jsonb
        WHERE id = :id`,
      { id: submitted.requestId },
    );

    const detail = await get('checkerA1', `/approvals/${String(submitted.requestId)}`).expect(200);
    expect(detail.body.data.diff.renderable).toBe(false);
    expect(detail.body.data.diff.problem).toBe('PAYLOAD_NOT_AN_OBJECT');
    // The request itself is still fully readable — it is governance evidence.
    expect(detail.body.data.request.id).toBe(submitted.requestId);

    // And the list containing it still works, which is the half of TC-20 that matters most.
    const queue = await get('checkerA1', '/approvals?pageSize=100').expect(200);
    expect(
      (queue.body.data as { id: number }[]).some((row) => row.id === submitted.requestId),
    ).toBe(true);

    // A NULL payload is the other shape a row can take.
    await exec('UPDATE reward_portal.portal_approval_requests SET payload = NULL WHERE id = :id', {
      id: submitted.requestId,
    });
    const missing = await get('checkerA1', `/approvals/${String(submitted.requestId)}`).expect(200);
    expect(missing.body.data.diff.problem).toBe('PAYLOAD_MISSING');

    // …and it is still decidable, because a diff is a reading aid, not a precondition.
    await post('checkerA1', `/approvals/${String(submitted.requestId)}/approve`).expect(200);
  });

  it('refuses a request whose entity_type this module has no decision path for', async () => {
    const submitted = await submitCampaign();
    await exec(
      `UPDATE reward_portal.portal_approval_requests SET entity_type = 'rule' WHERE id = :id`,
      { id: submitted.requestId },
    );

    const response = await post(
      'checkerA1',
      `/approvals/${String(submitted.requestId)}/approve`,
    ).expect(409);
    expect(response.body.error.code).toBe('APPROVAL_SUBJECT_UNSUPPORTED');
  });
});

// --- filters and shape ----------------------------------------------------------------------------

describe('T-038 · query contract', () => {
  it('filters on the stored status, and a stale pending row still appears under status=pending', async () => {
    const submitted = await submitCampaign();
    await exec(
      `UPDATE reward_portal.portal_approval_requests
          SET expires_at = now() - interval '1 hour' WHERE id = :id`,
      { id: submitted.requestId },
    );

    const response = await get('checkerA1', '/approvals?status=pending&pageSize=100').expect(200);
    const row = (response.body.data as { id: number; effectiveStatus: string }[]).find(
      (entry) => entry.id === submitted.requestId,
    );

    // Hiding it would make a request vanish from the queue with no record of why.
    expect(row?.effectiveStatus).toBe('expired');
  });

  it('combines both whitelisted filters, and returns an honest empty page when nothing matches', async () => {
    // Two filters at once (the `Op.and` branch), matched against an entity type nothing in this
    // tenant uses — so the queue is genuinely empty rather than merely small, and the name/subject
    // resolution has nothing to resolve.
    const response = await get(
      'checkerA1',
      '/approvals?status=expired&entityType=nothing_uses_this',
    ).expect(200);

    expect(response.body.data).toEqual([]);
    expect(response.body.meta.total).toBe(0);
  });

  it('rejects a status outside the five, and a query key nobody whitelisted', async () => {
    await get('checkerA1', '/approvals?status=nonsense').expect(400);
    await get('checkerA1', '/approvals?tenantId=1').expect(400);
    await get('checkerA1', '/approvals?entityType=NOT_LOWER').expect(400);
  });

  it('404s a request id that does not exist, in the same shape as one in another tenant', async () => {
    await get('checkerA1', '/approvals/999999999').expect(404);
    await post('checkerA1', '/approvals/999999999/approve').expect(404);
  });
});
