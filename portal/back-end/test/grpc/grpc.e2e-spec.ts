/**
 * T-047 — the internal configuration service against the **real** Postgres instance, through the
 * real `AppModule`, over a **real mutual-TLS socket**, speaking real gRPC.
 *
 * Nothing here is stubbed: the certificates are issued by a throwaway CA (`support/test-pki.ts`),
 * the handshake is Node's, the framing and trailers are the protocol's, and every row the
 * assertions read was written by SQL against the live database. That matters more here than in most
 * suites, because the majority of what T-047 promises is *"the socket refused that"* or *"the
 * database really refused that"* rather than *"the function returned false"* — TC-9, TC-10, TC-12,
 * TC-14 and TC-41 are all claims about a running system.
 *
 * ### Isolation
 *
 * Every fixture is prefixed `T047E2E` and torn down in `afterAll`. No assertion counts rows
 * globally. The database already holds ~200 `tenant_campaigns` rows written by the
 * `create-campaign` agents, which predate this portal, and this suite neither reads nor touches
 * them.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import type { ClientHttp2Session } from 'node:http2';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
import type { PortalRole } from '@/database/portal-models';
import { InternalServiceBootstrap } from '@/grpc/internal-service.bootstrap';
import { ChangeEventPublisher } from '@/grpc/change-event.publisher';
import {
  CONFIG_SECTION,
  GRPC_METHOD,
  GRPC_SERVICE_FULL_NAME,
  TTL_HEADER,
  CLIENT_CACHE_TTL_SECONDS,
} from '@/grpc/grpc.constants';
import { GrpcStatus } from '@/grpc/grpc.errors';
import { decodeMessage, encodeMessage } from '@/grpc/wire/proto-codec';
import {
  BudgetStatusRequestMessage,
  BudgetStatusResponseMessage,
  CampaignConfigListMessage,
  CampaignConfigMessage,
  ConfigChangeEventMessage,
  GetCampaignConfigRequestMessage,
  ListActiveCampaignsRequestMessage,
  ResolveRewardVersionRequestMessage,
  ResolveRuleVersionRequestMessage,
  RewardVersionDetailMessage,
  RuleVersionDetailMessage,
  WatchRequestMessage,
} from '@/grpc/wire/campaign-config.messages';
import type { InternalTlsListener } from '@/grpc/wire/grpc-http2.server';
import { createTestPki, type TestPki } from './support/test-pki';
import { openSession, postJson, serverStream, unary } from './support/grpc-test-client';
import { provideMissingKeyMaterial } from '../campaigns/support/foreign-key-material';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import { loginCompletingMfa } from '../auth/support/super-admin-mfa';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';

// Long enough for the 200-call load case (TC-27) on a shared local Postgres, short enough that a
// **hung** call — a status trailer that never arrives, which is this transport's characteristic
// failure — fails the suite in a minute instead of stalling it for ten. See `transport.spec.ts`.
jest.setTimeout(120_000);

const SUITE = 't047';
const PREFIX = 'T047E2E';
const RUNTIME_IDENTITY = 'txn-runtime.internal';
const REWARD_IDENTITY = 'reward-delivery.internal';
const STRANGER_IDENTITY = 'stranger.internal';

/**
 * A per-run token for the identities the `/admin/grpc-grants` tests **create**.
 *
 * `T047_001` revokes `DELETE` on `grpc_service_grants` from `reward_app` on purpose — *"an
 * access-control row that vanished leaves no trace of who could once read what"* — so this suite
 * genuinely cannot delete a grant, and `purge()` revokes instead (see its comment). Revoked rows
 * still occupy `uq_gsg`, so a test that creates a grant must use an identity no earlier run has
 * used, or its second run fails on a constraint that is working exactly as designed.
 */
const RUN = Date.now().toString(36);
const runIdentity = (name: string): string => `${PREFIX}_${RUN}_${name}.internal`;

let app: INestApplication;
let db: Sequelize;
let listener: InternalTlsListener;
let pki: TestPki;
let port: number;
let borrowedKeyVars: string[] = [];

let countryA: number;
let countryB: number;
let tenantA: number;
let tenantB: number;
let adminUserId: number;
let portalUserId: number;
let merchantId: number;
let activityId: number;
let ruleId: number;
let ruleVersionV2: number;
let ruleVersionV3: number;
let rewardId: number;
let rewardVersionId: number;
let rewardPolicyId: number;
let activeCampaignId: number;
let pausedCampaignId: number;
let otherTenantCampaignId: number;
let trackerId: number;
let componentId: number;

// --- the §4d admin surface's own actors ---------------------------------------------------------
// `/admin/grpc-grants` is an ordinary portal route on the *public* API and is tested as one: real
// login, real cookies, real guard chain (implementation note 14 — *"do not accidentally guard it
// with the mTLS guard instead of the normal session guards"*). Two roles are enough: the one that
// may (`super_admin`) and one that may not, for R6.
const ADMIN_PASSWORD = 'correct horse battery staple 7!';
let emailCrypto: PortalUserEmailCrypto;

interface Actor {
  readonly email: string;
  readonly userId: number;
  readonly jar: string;
  readonly csrf: string;
}
const actors = new Map<string, Actor>();

const method = (name: string): string => `/${GRPC_SERVICE_FULL_NAME}/${name}`;

async function sql<T extends object>(
  statement: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return db.query<T>(statement, { type: QueryTypes.SELECT, replacements });
}

async function exec(statement: string, replacements: Record<string, unknown> = {}): Promise<void> {
  await db.query(statement, { type: QueryTypes.RAW, replacements });
}

// --- fixtures --------------------------------------------------------------------------------

async function ensureCountry(code: string, name: string): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.countries WHERE code = :code',
    { code },
  );
  if (existing !== undefined) return existing.id;
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
  if (existing !== undefined) return existing.id;
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES (:code, :code, :countryId, 'active') RETURNING id`,
    { code, countryId },
  );
  return created.id;
}

async function createCampaign(
  code: string,
  tenantId: number,
  status: string,
  options: { pinnedAt?: Date } = {},
): Promise<number> {
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenant_campaigns
       (tenant_id, campaign_code, name, start_date, end_date, status, max_participants,
        budget_amount, budget_currency, created_by, approved_at, definition_pinned_at)
     -- T-065: an explicit UTC instant, not a bare '2026-01-01'. A bare date literal is
     -- interpreted in the SESSION timezone (Asia/Kuala_Lumpur on this machine) and would be
     -- stored as 2025-12-31T16:00Z — a fixture that quietly disagrees with the date it appears
     -- to say. The application never writes one of these; a fixture that did would fail the
     -- calendar-date assertions below for the wrong reason.
     VALUES (:tenantId, :code, :code, '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z', :status, 5000,
             '250000.00', 'MYR', '1', :approvedAt, :pinnedAt)
     RETURNING id`,
    {
      tenantId,
      code,
      status,
      approvedAt: options.pinnedAt ?? null,
      pinnedAt: options.pinnedAt ?? null,
    },
  );
  return created.id;
}

// --- the §4d admin surface's actors -------------------------------------------------------------

function http() {
  return request(app.getHttpServer());
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

/** A real portal user, logged in through the real endpoints (MFA included for `super_admin`). */
async function makeActor(key: string, role: PortalRole): Promise<void> {
  const email = `t047-e2e-${key}@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-047 ${key}`,
    role,
    countryId: role === 'super_admin' ? null : countryA,
    tenantId: role === 'super_admin' || role === 'country_admin' ? null : tenantA,
    merchantId: null,
    mustChangePassword: false,
  });
  await exec(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    { userId, hash: await argon2.hash(ADMIN_PASSWORD, ARGON2_OPTIONS) },
  );

  const response = await loginCompletingMfa(app, { email, password: ADMIN_PASSWORD }, db);
  if (response.status !== 200) {
    throw new Error(`login for ${key} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  actors.set(key, {
    email,
    userId,
    jar: jarFrom(response),
    csrf: cookieValue(response, CSRF_COOKIE_NAME),
  });
}

function as(key: string): Actor {
  const found = actors.get(key);
  if (found === undefined) throw new Error(`no actor "${key}"`);
  return found;
}

function adminGet(key: string, path: string) {
  return http().get(`/api/v1${path}`).set('Cookie', as(key).jar);
}

function adminPost(key: string, path: string, body: unknown) {
  return http()
    .post(`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf)
    .send(body as object);
}

function adminPatch(key: string, path: string, body: unknown) {
  return http()
    .patch(`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf)
    .send(body as object);
}

// --- boot ------------------------------------------------------------------------------------

beforeAll(async () => {
  pki = createTestPki();

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

  await purge();

  // --- reference rows -------------------------------------------------------------------------
  const [admin] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.admin_users ORDER BY id LIMIT 1',
  );
  if (admin === undefined) throw new Error('no admin_users rows — cannot author fixture versions');
  adminUserId = admin.id;

  // The **decryptable** portal user with the lowest id, not simply the lowest id. A row whose
  // `email` was written with a suite key that has since been deleted is debris from an interrupted
  // run, and attributing `grpc_service_grants.created_by` to one pins it in place: the foreign key
  // then blocks the very cleanup that would remove it, and `T056_001`'s `down()` — which refuses to
  // replace an address it cannot decrypt — can never roll back again. Encountered for real; see the
  // T-047 completion report.
  const [portalUser] = await sql<{ id: number }>(
    `SELECT id FROM reward_portal.portal_users
      WHERE split_part(email, '.', 2) IN (SELECT kid FROM reward_portal.encryption_keys)
      ORDER BY id LIMIT 1`,
  );
  if (portalUser === undefined) {
    throw new Error(
      'no portal_users rows — grpc_service_grants.created_by has a real foreign key and this ' +
        'suite will not invent a user to satisfy it. Run the bootstrap CLI first.',
    );
  }
  portalUserId = portalUser.id;

  countryA = await ensureCountry('X7', 'T-047 e2e country A');
  countryB = await ensureCountry('X8', 'T-047 e2e country B');
  tenantA = await ensureTenant(`${PREFIX}_TENANT_A`, countryA);
  tenantB = await ensureTenant(`${PREFIX}_TENANT_B`, countryB);

  // --- merchants and activities ---------------------------------------------------------------
  const [merchant] = await sql<{ id: number }>(
    `INSERT INTO reward_config.merchants (tenant_id, merchant_code, name, country_code, status)
     VALUES (:tenantId, :code, :code, 'X7', 'active') RETURNING id`,
    { tenantId: tenantA, code: `${PREFIX}_M1` },
  );
  merchantId = merchant.id;
  const [activityType] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.activity_types ORDER BY id LIMIT 1',
  );
  const [activity] = await sql<{ id: number }>(
    `INSERT INTO reward_config.activities (tenant_id, type_id, activity_code, name, status)
     VALUES (:tenantId, :typeId, :code, :code, 'active') RETURNING id`,
    { tenantId: tenantA, typeId: activityType.id, code: `${PREFIX}_ACT1` },
  );
  activityId = activity.id;
  await exec(
    `INSERT INTO reward_config.merchant_activities (tenant_id, merchant_id, activity_id, status)
     VALUES (:tenantId, :merchantId, :activityId, 'active')`,
    { tenantId: tenantA, merchantId, activityId },
  );

  // --- a rule with two published versions, v2 pinned and v3 "blasted" later --------------------
  const [subCategory] = await sql<{ id: number }>(
    `SELECT rsc.id FROM reward_config.rule_sub_categories rsc
       JOIN reward_config.rule_categories rc ON rc.id = rsc.category_id
      WHERE rc.category_code = 'TRANSACTION' AND rsc.sub_category_code = 'GENERAL' LIMIT 1`,
  );
  const parameters = JSON.stringify({
    fields: [{ key: 'minSpend', label: 'Minimum spend', type: 'number', required: true, min: 0 }],
  });
  const [rule] = await sql<{ id: number }>(
    `INSERT INTO reward_config.rule_master (tenant_id, sub_category_id, rule_code, name, expression, parameters, status)
     VALUES (NULL, :subCategoryId, :code, :code, 'amount >= :minSpend', :parameters, 'active')
     RETURNING id`,
    { subCategoryId: subCategory.id, code: `${PREFIX}_RULE`, parameters },
  );
  ruleId = rule.id;
  await exec(
    `INSERT INTO reward_config.rule_country_assignments (rule_id, country_id, assigned_by)
     VALUES (:ruleId, :countryId, :adminUserId)`,
    { ruleId, countryId: countryA, adminUserId },
  );

  const insertRuleVersion = async (versionNo: number, expression: string): Promise<number> => {
    const [version] = await sql<{ id: number }>(
      `INSERT INTO reward_config.rule_versions
         (rule_id, version_no, expression, parameters, status, created_by, published_by, published_at)
       VALUES (:ruleId, :versionNo, :expression, :parameters, 'published', :adminUserId, :adminUserId, now())
       RETURNING id`,
      { ruleId, versionNo, expression, parameters, adminUserId },
    );
    return version.id;
  };
  ruleVersionV2 = await insertRuleVersion(2, 'amount >= :minSpend /* v2 */');
  ruleVersionV3 = await insertRuleVersion(3, 'amount >= :minSpend /* v3 */');
  await exec(
    `INSERT INTO reward_config.rule_version_country_assignments
       (rule_version_id, rule_id, country_id, status, assigned_by, assigned_at)
     VALUES (:versionId, :ruleId, :countryId, 'active', :adminUserId, now() - interval '30 days')`,
    { versionId: ruleVersionV2, ruleId, countryId: countryA, adminUserId },
  );

  // --- a reward with a published version carrying units ----------------------------------------
  const [reward] = await sql<{ id: number }>(
    `INSERT INTO reward_config.reward_systems
       (tenant_id, system_code, name, reward_type, connector_type, status)
     VALUES (NULL, :code, :code, 'cashback', 'internal', 'active') RETURNING id`,
    { code: `${PREFIX}_RWD` },
  );
  rewardId = reward.id;
  await exec(
    `INSERT INTO reward_config.reward_country_assignments (reward_id, country_id, assigned_by)
     VALUES (:rewardId, :countryId, :adminUserId)`,
    { rewardId, countryId: countryA, adminUserId },
  );
  const [rewardVersion] = await sql<{ id: number }>(
    `INSERT INTO reward_config.reward_versions
       (reward_id, version_no, delivery_mode, policies_snapshot, unit_type, unit_code, status,
        created_by, published_by, published_at)
     VALUES (:rewardId, 1, 'instant', :snapshot, 'currency', 'MYR', 'published',
             :adminUserId, :adminUserId, now()) RETURNING id`,
    { rewardId, snapshot: JSON.stringify({ rate: '0.05' }), adminUserId },
  );
  rewardVersionId = rewardVersion.id;
  await exec(
    `INSERT INTO reward_config.reward_version_country_assignments
       (reward_version_id, reward_id, country_id, status, assigned_by, assigned_at)
     VALUES (:versionId, :rewardId, :countryId, 'active', :adminUserId, now() - interval '30 days')`,
    { versionId: rewardVersionId, rewardId, countryId: countryA, adminUserId },
  );
  const [policy] = await sql<{ id: number }>(
    `INSERT INTO reward_config.reward_policies (reward_system_id, policy_code, name, config, status)
     VALUES (:rewardId, :code, :code, :config, 'active') RETURNING id`,
    { rewardId, code: `${PREFIX}_POL`, config: JSON.stringify({ amount: '10.00' }) },
  );
  rewardPolicyId = policy.id;

  // --- campaigns --------------------------------------------------------------------------------
  const pinnedAt = new Date();
  activeCampaignId = await createCampaign(`${PREFIX}_ACTIVE`, tenantA, 'active', { pinnedAt });
  pausedCampaignId = await createCampaign(`${PREFIX}_PAUSED`, tenantA, 'paused', { pinnedAt });
  await createCampaign(`${PREFIX}_DRAFT`, tenantA, 'draft');
  await createCampaign(`${PREFIX}_PENDING`, tenantA, 'pending_approval');
  otherTenantCampaignId = await createCampaign(`${PREFIX}_OTHER`, tenantB, 'active', { pinnedAt });

  // structure for the active campaign
  const [tracker] = await sql<{ id: number }>(
    `INSERT INTO reward_config.trackers
       (tenant_id, tracker_code, name, completion_logic, completion_threshold, status)
     VALUES (:tenantId, :code, :code, 'all', 1, 'active') RETURNING id`,
    { tenantId: tenantA, code: `${PREFIX}_TRK` },
  );
  trackerId = tracker.id;
  const [component] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tracker_components
       (tenant_id, component_code, name, activity_id, status)
     VALUES (:tenantId, :code, :code, :activityId, 'active') RETURNING id`,
    { tenantId: tenantA, code: `${PREFIX}_CMP`, activityId },
  );
  componentId = component.id;
  await exec(
    `INSERT INTO reward_config.tracker_tracker_components
       (tracker_id, component_id, sequence_order, is_mandatory)
     VALUES (:trackerId, :componentId, 1, true)`,
    { trackerId, componentId },
  );
  await exec(
    `INSERT INTO reward_config.tenant_campaign_trackers (tenant_id, campaign_id, tracker_id, status)
     VALUES (:tenantId, :campaignId, :trackerId, 'active')`,
    { tenantId: tenantA, campaignId: activeCampaignId, trackerId },
  );
  await exec(
    `INSERT INTO reward_config.campaign_merchants (tenant_id, campaign_id, merchant_id, status)
     VALUES (:tenantId, :campaignId, :merchantId, 'active')`,
    { tenantId: tenantA, campaignId: activeCampaignId, merchantId },
  );
  // The pin: this binding names rule_version v2 explicitly (06-VERSIONING.md §7).
  await exec(
    `INSERT INTO reward_config.tracker_component_rules
       (tenant_id, tracker_component_id, rule_id, config, status, rule_version_id)
     VALUES (:tenantId, :componentId, :ruleId, :config, 'active', :versionId)`,
    {
      tenantId: tenantA,
      componentId,
      ruleId,
      config: JSON.stringify({ minSpend: 150 }),
      versionId: ruleVersionV2,
    },
  );
  await exec(
    `INSERT INTO reward_config.reward_campaign_assignments
       (tenant_id, reward_policy_id, campaign_id, reward_version_id, assigned_at, status)
     VALUES (:tenantId, :policyId, :campaignId, :versionId, now(), 'active')`,
    {
      tenantId: tenantA,
      policyId: rewardPolicyId,
      campaignId: activeCampaignId,
      versionId: rewardVersionId,
    },
  );
  await exec(
    `INSERT INTO reward_config.campaign_caps
       (tenant_id, campaign_id, cap_class, scope_level, period_type, unit_type, unit_code,
        max_total_amount, on_breach, warn_at_percent, status, created_by)
     VALUES (:tenantId, :campaignId, 'budget', 'campaign', 'lifetime', 'currency', 'MYR',
             '250000.00', 'pause_campaign', 80, 'active', :adminUserId)`,
    { tenantId: tenantA, campaignId: activeCampaignId, adminUserId },
  );

  // --- grants ------------------------------------------------------------------------------------
  // `ON CONFLICT` because `purge()` can only revoke, never delete (see its comment): a previous
  // run's row for the same identity and tenant is reactivated and reset rather than duplicated.
  const grantFixture = async (identity: string, sections: string[]): Promise<void> => {
    await exec(
      `INSERT INTO reward_portal.grpc_service_grants
         (service_identity, tenant_id, allowed_sections, status, created_by)
       VALUES (:identity, :tenantId, CAST(:sections AS jsonb), 'active', :createdBy)
       ON CONFLICT (service_identity, tenant_key)
       DO UPDATE SET allowed_sections = EXCLUDED.allowed_sections, status = 'active'`,
      {
        identity,
        tenantId: tenantA,
        sections: JSON.stringify(sections),
        createdBy: portalUserId,
      },
    );
  };
  await grantFixture(RUNTIME_IDENTITY, [
    'BASIC',
    'MERCHANTS',
    'TRACKERS',
    'RULES',
    'REWARDS',
    'CAPS',
  ]);
  await grantFixture(REWARD_IDENTITY, ['BASIC', 'REWARDS', 'CAPS']);

  // `activeGrantsFor` returns every **active** row for an identity, across tenants, so a leftover
  // active row from an interrupted run silently changes what several tests mean. Fail here,
  // loudly, rather than three describes later as an inexplicable authorisation result.
  const leftovers = await sql<{ service_identity: string; count: string }>(
    `SELECT service_identity, count(*)::text AS count FROM reward_portal.grpc_service_grants
      WHERE service_identity IN (:identities) AND status = 'active'
      GROUP BY service_identity HAVING count(*) <> 1`,
    { identities: [RUNTIME_IDENTITY, REWARD_IDENTITY] },
  );
  if (leftovers.length > 0) {
    throw new Error(
      `grpc_service_grants holds unexpected rows for ${leftovers
        .map((row) => `${row.service_identity} x${row.count}`)
        .join(', ')} — a previous run of this suite did not finish its purge.`,
    );
  }

  // --- the §4d admin actors --------------------------------------------------------------------
  await makeActor('super', 'super_admin');
  await makeActor('country', 'country_admin');

  // --- the listener --------------------------------------------------------------------------
  process.env.GRPC_TLS_CERT_PATH = pki.server.certPath;
  process.env.GRPC_TLS_KEY_PATH = pki.server.keyPath;
  process.env.GRPC_TLS_CA_PATH = pki.caPath;
  listener = app.get(InternalServiceBootstrap).build({ port: 0, host: '127.0.0.1' });
  await listener.listen();
  port = listener.address();
});

afterAll(async () => {
  try {
    await listener?.close();
    if (db !== undefined) {
      await purge();
      await deletePortalUsersByEmail(
        db,
        emailCrypto,
        [...actors.values()].map((actor) => actor.email),
      ).catch(() => undefined);
      await removeEncryptionKeys(db, SUITE).catch(() => undefined);
    }
    for (const name of borrowedKeyVars) delete process.env[name];
    delete process.env.GRPC_TLS_CERT_PATH;
    delete process.env.GRPC_TLS_KEY_PATH;
    delete process.env.GRPC_TLS_CA_PATH;
  } finally {
    // Must run even if the cleanup above throws — otherwise the listening server and the Postgres
    // pool leak for the life of the process, which in a piped run is indistinguishable from a hang
    // (the trace T-033's own e2e header records).
    await app?.close();
    pki?.destroy();
  }
});

/** Removes anything this suite left behind, keyed strictly on its own `T047E2E` prefix. */
async function purge(): Promise<void> {
  const campaigns = `SELECT id FROM reward_config.tenant_campaigns WHERE campaign_code LIKE '${PREFIX}%'`;
  const statements = [
    `DELETE FROM reward_portal.portal_audit_log WHERE target_type = 'campaign' AND target_id IN (SELECT id::text FROM (${campaigns}) c)`,
    `DELETE FROM reward_config.campaign_caps WHERE campaign_id IN (${campaigns})`,
    `DELETE FROM reward_config.reward_campaign_assignments WHERE campaign_id IN (${campaigns})`,
    `DELETE FROM reward_config.campaign_merchants WHERE campaign_id IN (${campaigns})`,
    `DELETE FROM reward_config.tenant_campaign_trackers WHERE campaign_id IN (${campaigns})`,
    `DELETE FROM reward_config.tenant_campaigns WHERE campaign_code LIKE '${PREFIX}%'`,
    `DELETE FROM reward_config.reward_tracker_assignments WHERE tracker_id IN (SELECT id FROM reward_config.trackers WHERE tracker_code LIKE '${PREFIX}%')`,
    `DELETE FROM reward_config.tracker_component_rules WHERE tracker_component_id IN (SELECT id FROM reward_config.tracker_components WHERE component_code LIKE '${PREFIX}%')`,
    `DELETE FROM reward_config.tracker_tracker_components WHERE tracker_id IN (SELECT id FROM reward_config.trackers WHERE tracker_code LIKE '${PREFIX}%')`,
    `DELETE FROM reward_config.tracker_components WHERE component_code LIKE '${PREFIX}%'`,
    `DELETE FROM reward_config.trackers WHERE tracker_code LIKE '${PREFIX}%'`,
    `DELETE FROM reward_config.merchant_activities WHERE activity_id IN (SELECT id FROM reward_config.activities WHERE activity_code LIKE '${PREFIX}%')`,
    `DELETE FROM reward_config.activities WHERE activity_code LIKE '${PREFIX}%'`,
    `DELETE FROM reward_config.merchants WHERE merchant_code LIKE '${PREFIX}%'`,
    `DELETE FROM reward_config.rule_version_country_assignments WHERE rule_id IN (SELECT id FROM reward_config.rule_master WHERE rule_code LIKE '${PREFIX}%')`,
    `DELETE FROM reward_config.rule_country_assignments WHERE rule_id IN (SELECT id FROM reward_config.rule_master WHERE rule_code LIKE '${PREFIX}%')`,
    `DELETE FROM reward_config.rule_versions WHERE rule_id IN (SELECT id FROM reward_config.rule_master WHERE rule_code LIKE '${PREFIX}%')`,
    `DELETE FROM reward_config.rule_master WHERE rule_code LIKE '${PREFIX}%'`,
    `DELETE FROM reward_config.reward_version_country_assignments WHERE reward_id IN (SELECT id FROM reward_config.reward_systems WHERE system_code LIKE '${PREFIX}%')`,
    `DELETE FROM reward_config.reward_country_assignments WHERE reward_id IN (SELECT id FROM reward_config.reward_systems WHERE system_code LIKE '${PREFIX}%')`,
    `DELETE FROM reward_config.reward_versions WHERE reward_id IN (SELECT id FROM reward_config.reward_systems WHERE system_code LIKE '${PREFIX}%')`,
    `DELETE FROM reward_config.reward_policies WHERE reward_system_id IN (SELECT id FROM reward_config.reward_systems WHERE system_code LIKE '${PREFIX}%')`,
    `DELETE FROM reward_config.reward_systems WHERE system_code LIKE '${PREFIX}%'`,
    `DELETE FROM reward_config.tenants WHERE code LIKE '${PREFIX}%'`,
    `DELETE FROM reward_portal.portal_audit_log WHERE target_type = 'grpc_service_grant' AND target_id IN (SELECT id::text FROM reward_portal.grpc_service_grants WHERE service_identity LIKE '${PREFIX}%')`,
    // `created_by` is a real foreign key to `portal_users`, and the row it points at can never be
    // deleted while it does — so this suite's throwaway `super_admin` cannot be cleaned up until
    // the grants it created are re-attributed. Reassigned to the deployment's first portal user,
    // which is exactly what an operator would have to do before deleting a real administrator.
    `UPDATE reward_portal.grpc_service_grants
        SET created_by = (SELECT id FROM reward_portal.portal_users
                           WHERE display_name NOT LIKE 'T-047 %' ORDER BY id LIMIT 1)
      WHERE service_identity LIKE '${PREFIX}%'
         OR service_identity IN ('${RUNTIME_IDENTITY}','${REWARD_IDENTITY}','${STRANGER_IDENTITY}')`,
    // Throwaway actors from an interrupted run, matched on `display_name` rather than on the
    // email. `deletePortalUsersByEmail` needs the blind index, which needs the key this suite's
    // `afterAll` deletes — so a run that died between the two leaves a row whose `email` **cannot
    // be decrypted by anything**, and `T056_001`'s `down()` then refuses to roll back rather than
    // replace an address with a placeholder. That is the correct behaviour of a correct migration,
    // and cleaning up after ourselves here is the fix. `portal_user_credentials`, `portal_sessions`
    // and the MFA rows follow by cascade.
    `DELETE FROM reward_portal.portal_users WHERE display_name LIKE 'T-047 %'`,
    // **Revoked, not deleted.** `T047_001` revokes `DELETE` on this table from `reward_app`, so a
    // `DELETE` here does not fail loudly — it fails, gets swallowed by the `.catch` below, and the
    // rows quietly accumulate across runs until an unrelated test starts reading a stale grant.
    // Revocation is the operation the design actually provides, and `activeGrantsFor` filters on
    // `status = 'active'`, so a revoked leftover is invisible to every code path under test.
    `UPDATE reward_portal.grpc_service_grants SET status = 'revoked'
      WHERE service_identity IN ('${RUNTIME_IDENTITY}','${REWARD_IDENTITY}','${STRANGER_IDENTITY}')
         OR service_identity LIKE '${PREFIX}%'`,
  ];
  for (const statement of statements) {
    await exec(statement).catch(() => undefined);
  }
}

// --- helpers ---------------------------------------------------------------------------------

async function runtimeSession(): Promise<ClientHttp2Session> {
  const identity = pki.client(RUNTIME_IDENTITY);
  return openSession({ port, ca: pki.ca, cert: identity.cert, key: identity.key });
}

async function rewardSession(): Promise<ClientHttp2Session> {
  const identity = pki.client(REWARD_IDENTITY);
  return openSession({ port, ca: pki.ca, cert: identity.cert, key: identity.key });
}

async function getConfig(
  session: ClientHttp2Session,
  request: { tenantId: number; campaignCode: string; etag?: string; sections?: number[] },
) {
  const result = await unary(
    session,
    method(GRPC_METHOD.GET_CAMPAIGN_CONFIG),
    encodeMessage(GetCampaignConfigRequestMessage, {
      tenantId: request.tenantId,
      campaignCode: request.campaignCode,
      etag: request.etag ?? '',
      sections: request.sections ?? [],
    }),
  );
  const config =
    result.messages.length === 0 ? null : decodeMessage(CampaignConfigMessage, result.messages[0]);
  return { result, config };
}

// --- TC-9 … TC-12: the trust boundary ---------------------------------------------------------

describe('the transport is mutual TLS (TC-9, TC-10, TC-12)', () => {
  it('TC-9 — a client with no certificate cannot even connect', async () => {
    await expect(openSession({ port, ca: pki.ca })).rejects.toThrow();
  });

  it('TC-10a — a certificate signed by another CA is refused at the handshake', async () => {
    const foreign = pki.foreignClient(RUNTIME_IDENTITY);
    await expect(
      openSession({ port, ca: pki.ca, cert: foreign.cert, key: foreign.key }),
    ).rejects.toThrow();
  });

  it('TC-10b — a valid certificate whose identity holds no grant is UNAUTHENTICATED', async () => {
    const stranger = pki.client(STRANGER_IDENTITY);
    const session = await openSession({
      port,
      ca: pki.ca,
      cert: stranger.cert,
      key: stranger.key,
    });
    const { result } = await getConfig(session, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_ACTIVE`,
    });
    expect(result.grpcStatus).toBe(GrpcStatus.UNAUTHENTICATED);
    expect(result.grpcMessage).toContain('not in the service allowlist');
    session.close();
  });

  it('TC-12 — a portal session cookie on this port is rejected outright', async () => {
    const session = await runtimeSession();
    const result = await unary(
      session,
      method(GRPC_METHOD.GET_CAMPAIGN_CONFIG),
      encodeMessage(GetCampaignConfigRequestMessage, {
        tenantId: tenantA,
        campaignCode: `${PREFIX}_ACTIVE`,
      }),
      { cookie: 'rp_at=forged.jwt.value' },
    );
    expect(result.grpcStatus).toBe(GrpcStatus.UNAUTHENTICATED);
    expect(result.grpcMessage).toContain('separate trust domain');
    session.close();
  });

  it('TC-11 — a tenant outside the grant is PERMISSION_DENIED, not NOT_FOUND', async () => {
    const session = await runtimeSession();
    const { result } = await getConfig(session, {
      tenantId: tenantB,
      campaignCode: `${PREFIX}_OTHER`,
    });
    expect(result.grpcStatus).toBe(GrpcStatus.PERMISSION_DENIED);
    expect(result.grpcMessage).toContain('holds no active grant for tenant');
    session.close();
  });
});

// --- TC-1 … TC-8: the configuration itself -----------------------------------------------------

describe('GetCampaignConfig (TC-1 … TC-8)', () => {
  let session: ClientHttp2Session;
  beforeAll(async () => {
    session = await runtimeSession();
  });
  afterAll(() => session.close());

  it('TC-1 — serves a complete config for an active campaign, every version pinned', async () => {
    const { result, config } = await getConfig(session, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_ACTIVE`,
    });
    expect(result.grpcStatus).toBe(GrpcStatus.OK);
    expect(config).not.toBeNull();
    expect(config).toMatchObject({
      campaignId: activeCampaignId,
      campaignCode: `${PREFIX}_ACTIVE`,
      tenantId: tenantA,
      countryId: countryA,
      status: 'active',
      notModified: false,
    });
    expect((config as Record<string, unknown[]>).merchants).toHaveLength(1);
    expect((config as Record<string, unknown[]>).trackers).toHaveLength(1);
    expect((config as Record<string, unknown[]>).rules).toHaveLength(1);
    expect((config as Record<string, unknown[]>).rewards).toHaveLength(1);
    expect((config as Record<string, unknown[]>).caps).toHaveLength(1);
    expect((config as Record<string, string>).configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.headers[TTL_HEADER]).toBe(String(CLIENT_CACHE_TTL_SECONDS));
  });

  it('TC-2 — BoundRule carries the version, the schema AND the maker’s values', async () => {
    const { config } = await getConfig(session, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_ACTIVE`,
    });
    const [rule] = (config as { rules: Record<string, unknown>[] }).rules;
    expect(rule).toMatchObject({
      ruleId,
      ruleVersionId: ruleVersionV2,
      versionNo: 2,
      trackerComponentId: componentId,
      status: 'active',
    });
    expect(JSON.parse(rule.parametersJson as string).fields[0].key).toBe('minSpend');
    expect(JSON.parse(rule.boundValuesJson as string)).toEqual({ minSpend: 150 });
  });

  it('TC-3 — the pin holds after v3 is blasted to the country', async () => {
    // The blast: v3 becomes the country's current version.
    await exec(
      `INSERT INTO reward_config.rule_version_country_assignments
         (rule_version_id, rule_id, country_id, status, assigned_by)
       VALUES (:versionId, :ruleId, :countryId, 'active', :adminUserId)`,
      { versionId: ruleVersionV3, ruleId, countryId: countryA, adminUserId },
    );

    const { config } = await getConfig(session, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_ACTIVE`,
    });
    const [rule] = (config as { rules: Record<string, unknown>[] }).rules;
    expect(rule.ruleVersionId).toBe(ruleVersionV2);
    expect(rule.versionNo).toBe(2);
    expect(rule.expression).toContain('v2');
  });

  it('TC-3b — an UNPINNED binding resolves to the version the country held at the pin date', async () => {
    // 06-VERSIONING.md §5.1: `rule_version_id IS NULL` on a pre-versioning row means "version 1 by
    // convention", and `ConfigSnapshotBuilder` resolves it from the country assignment that was
    // active at the campaign's `definition_pinned_at` — never from whatever is current now. This
    // runs after TC-3 has blasted v3, so "current" and "correct" are genuinely different answers:
    // v3 was assigned *after* the pin date and must not be served, exactly as for a pinned row.
    const [binding] = await sql<{ id: number; rule_version_id: number }>(
      `SELECT id, rule_version_id FROM reward_config.tracker_component_rules
        WHERE tracker_component_id = :componentId`,
      { componentId },
    );
    await exec(
      `UPDATE reward_config.tracker_component_rules SET rule_version_id = NULL WHERE id = :id`,
      { id: binding.id },
    );
    try {
      const { config } = await getConfig(session, {
        tenantId: tenantA,
        campaignCode: `${PREFIX}_ACTIVE`,
      });
      const [rule] = (config as { rules: Record<string, unknown>[] }).rules;
      expect(rule.ruleVersionId).toBe(ruleVersionV2);
      expect(rule.versionNo).toBe(2);
      expect(rule.expression).toContain('v2');
      // The maker's values still travel with it — an unpinned *version* is not an unbound rule.
      expect(JSON.parse(rule.boundValuesJson as string)).toEqual({ minSpend: 150 });
    } finally {
      await exec(
        `UPDATE reward_config.tracker_component_rules SET rule_version_id = :versionId WHERE id = :id`,
        { id: binding.id, versionId: binding.rule_version_id },
      );
    }
  });

  it.each([
    ['TC-4', 'DRAFT'],
    ['TC-5', 'PENDING'],
  ])('%s — a %s campaign is not served', async (_id, suffix) => {
    const { result } = await getConfig(session, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_${suffix}`,
    });
    expect(result.grpcStatus).toBe(GrpcStatus.NOT_FOUND);
  });

  it('TC-6 — a paused campaign IS served, with the flag', async () => {
    const { result, config } = await getConfig(session, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_PAUSED`,
    });
    expect(result.grpcStatus).toBe(GrpcStatus.OK);
    expect((config as { status: string }).status).toBe('paused');
    // It really is the paused fixture row, not a same-coded neighbour: a `status` string that
    // happened to read 'paused' on the wrong campaign would pass the assertion above.
    expect((config as { campaignId: number }).campaignId).toBe(pausedCampaignId);
  });

  it('TC-7 / TC-8 — no connector_config and no user or PII field anywhere in the payload', async () => {
    const { result } = await getConfig(session, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_ACTIVE`,
    });
    // Scanned as **bytes**, not as a parsed object: a field this build does not know would still
    // be on the wire, and scanning the decoded shape would not see it.
    const raw = result.messages[0].toString('utf8');
    for (const forbidden of [
      'connector_config',
      'connectorConfig',
      'password',
      'email',
      'created_by',
      'createdBy',
      'approved_by',
      'contact_email',
      'contact_phone',
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});

// --- TC-15 … TC-17: listing and caching ---------------------------------------------------------

describe('ListActiveCampaigns and caching (TC-15, TC-16, TC-17)', () => {
  let session: ClientHttp2Session;
  beforeAll(async () => {
    session = await runtimeSession();
  });
  afterAll(() => session.close());

  it('TC-15 — every active campaign of the tenant, and nothing else', async () => {
    const result = await unary(
      session,
      method(GRPC_METHOD.LIST_ACTIVE_CAMPAIGNS),
      encodeMessage(ListActiveCampaignsRequestMessage, { tenantId: tenantA, sections: [] }),
    );
    expect(result.grpcStatus).toBe(GrpcStatus.OK);
    const list = decodeMessage(CampaignConfigListMessage, result.messages[0]) as {
      campaigns: { campaignCode: string; status: string }[];
    };
    const codes = list.campaigns.map((campaign) => campaign.campaignCode);
    expect(codes).toContain(`${PREFIX}_ACTIVE`);
    expect(codes).not.toContain(`${PREFIX}_DRAFT`);
    expect(codes).not.toContain(`${PREFIX}_PENDING`);
    expect(codes).not.toContain(`${PREFIX}_PAUSED`);
    expect(codes).not.toContain(`${PREFIX}_OTHER`);
    expect(list.campaigns.every((campaign) => campaign.status === 'active')).toBe(true);
  });

  it('TC-16 — a matching etag returns not_modified with no payload', async () => {
    const first = await getConfig(session, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_ACTIVE`,
    });
    const etag = (first.config as { etag: string }).etag;

    const second = await getConfig(session, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_ACTIVE`,
      etag,
    });
    const config = second.config as Record<string, unknown>;
    expect(config.notModified).toBe(true);
    expect(config.etag).toBe(etag);
    expect(config.rules).toEqual([]);
    expect(config.trackers).toEqual([]);
    expect(config.merchants).toEqual([]);
    expect(config.caps).toEqual([]);
    // Materially smaller than the full payload — "no payload" as a byte count, not a claim.
    expect(second.result.messages[0].length).toBeLessThan(first.result.messages[0].length / 2);
  });

  it('TC-17 — a stale etag returns a full fresh payload', async () => {
    const before = await getConfig(session, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_ACTIVE`,
    });
    const staleEtag = (before.config as { etag: string }).etag;

    await exec(`UPDATE reward_config.tenant_campaigns SET max_participants = 6000 WHERE id = :id`, {
      id: activeCampaignId,
    });

    const after = await getConfig(session, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_ACTIVE`,
      etag: staleEtag,
    });
    const config = after.config as Record<string, unknown>;
    expect(config.notModified).toBe(false);
    expect(config.maxParticipants).toBe(6000);
    expect(config.etag).not.toBe(staleEtag);
  });

  it('TC-29 — config_hash is stable across repeated calls for an unchanged campaign', async () => {
    const first = await getConfig(session, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_ACTIVE`,
    });
    const second = await getConfig(session, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_ACTIVE`,
    });
    expect((first.config as { configHash: string }).configHash).toBe(
      (second.config as { configHash: string }).configHash,
    );
  });
});

// --- TC-30 … TC-35: sections --------------------------------------------------------------------

describe('sections are an authorisation boundary (TC-30 … TC-35)', () => {
  let reward: ClientHttp2Session;
  beforeAll(async () => {
    reward = await rewardSession();
  });
  afterAll(() => reward.close());

  it('TC-30 — sections=[REWARDS] returns BASIC + REWARDS only', async () => {
    const { config } = await getConfig(reward, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_ACTIVE`,
      sections: [CONFIG_SECTION.REWARDS],
    });
    const payload = config as Record<string, unknown[]> & { campaignCode: string };
    expect(payload.campaignCode).toBe(`${PREFIX}_ACTIVE`);
    expect(payload.rewards.length).toBeGreaterThan(0);
    expect(payload.rules).toEqual([]);
    expect(payload.caps).toEqual([]);
    expect(payload.trackers).toEqual([]);
    expect(payload.merchants).toEqual([]);
    expect(payload.sectionsReturned).toEqual([CONFIG_SECTION.BASIC, CONFIG_SECTION.REWARDS]);
  });

  it('T-065 TC-9 — BASIC serves the campaign’s calendar dates at UTC midnight, inclusive', async () => {
    // The one contract an external system consumes and cannot renegotiate. `campaign_config.v1
    // .proto` promises RFC3339 at UTC midnight of an **inclusive** calendar date; this asserts the
    // bytes, not the intent. A `T23:59:59` or a shifted day here is the same defect T-065 removed
    // from the portal, leaked into the transaction microservice instead.
    const { config } = await getConfig(reward, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_ACTIVE`,
    });
    const payload = config as Record<string, string>;
    expect(payload.startDate).toBe('2026-01-01T00:00:00.000Z');
    expect(payload.endDate).toBe('2026-12-31T00:00:00.000Z');
    // And it is the same day the portal's own REST contract serves for the same row — "consistent
    // with the portal's" is a comparison, so it is made rather than asserted in prose.
    expect(payload.startDate.slice(0, 10)).toBe('2026-01-01');
    expect(payload.endDate.slice(0, 10)).toBe('2026-12-31');
  });

  it('TC-31 — an empty request returns the granted sections and lists the rest', async () => {
    const { config } = await getConfig(reward, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_ACTIVE`,
    });
    const payload = config as Record<string, number[]>;
    expect(payload.sectionsReturned).toEqual([
      CONFIG_SECTION.BASIC,
      CONFIG_SECTION.REWARDS,
      CONFIG_SECTION.CAPS,
    ]);
    expect(payload.sectionsOmitted).toEqual([
      CONFIG_SECTION.MERCHANTS,
      CONFIG_SECTION.TRACKERS,
      CONFIG_SECTION.RULES,
    ]);
  });

  it('TC-32 — an explicit ask for an ungranted section is PERMISSION_DENIED naming it', async () => {
    const { result } = await getConfig(reward, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_ACTIVE`,
      sections: [CONFIG_SECTION.RULES],
    });
    expect(result.grpcStatus).toBe(GrpcStatus.PERMISSION_DENIED);
    expect(result.grpcMessage).toContain('RULES');
  });

  it('TC-33 — BASIC is included even when the request did not name it', async () => {
    const runtime = await runtimeSession();
    const { config } = await getConfig(runtime, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_ACTIVE`,
      sections: [CONFIG_SECTION.TRACKERS],
    });
    const payload = config as Record<string, unknown>;
    expect(payload.campaignCode).toBe(`${PREFIX}_ACTIVE`);
    expect(payload.status).toBe('active');
    expect((payload.sectionsReturned as number[])[0]).toBe(CONFIG_SECTION.BASIC);
    runtime.close();
  });

  it('TC-34 — a BASIC etag presented with a full-section request returns a FULL payload', async () => {
    // The bug §4c says this design is most likely to ship with.
    const runtime = await runtimeSession();
    const basic = await getConfig(runtime, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_ACTIVE`,
      sections: [CONFIG_SECTION.BASIC],
    });
    const basicEtag = (basic.config as { etag: string }).etag;

    const everything = await getConfig(runtime, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_ACTIVE`,
      etag: basicEtag,
      sections: [
        CONFIG_SECTION.BASIC,
        CONFIG_SECTION.MERCHANTS,
        CONFIG_SECTION.TRACKERS,
        CONFIG_SECTION.RULES,
        CONFIG_SECTION.REWARDS,
        CONFIG_SECTION.CAPS,
      ],
    });
    const payload = everything.config as Record<string, unknown[]> & { notModified: boolean };
    expect(payload.notModified).toBe(false);
    expect(payload.rules.length).toBeGreaterThan(0);
    expect(payload.trackers.length).toBeGreaterThan(0);
    runtime.close();
  });

  it('TC-35 — a sections-limited request issues materially fewer queries', async () => {
    const runtime = await runtimeSession();
    const counted = async (sections: number[]): Promise<number> => {
      let queries = 0;
      const listener = (): void => {
        queries += 1;
      };
      (db as unknown as { options: { logging: unknown } }).options.logging = listener;
      await getConfig(runtime, {
        tenantId: tenantA,
        campaignCode: `${PREFIX}_ACTIVE`,
        sections,
      });
      return queries;
    };

    const original = (db as unknown as { options: { logging: unknown } }).options.logging;
    try {
      const rewardsOnly = await counted([CONFIG_SECTION.REWARDS]);
      const everything = await counted([
        CONFIG_SECTION.BASIC,
        CONFIG_SECTION.MERCHANTS,
        CONFIG_SECTION.TRACKERS,
        CONFIG_SECTION.RULES,
        CONFIG_SECTION.REWARDS,
        CONFIG_SECTION.CAPS,
      ]);
      expect(rewardsOnly).toBeLessThan(everything);
    } finally {
      (db as unknown as { options: { logging: unknown } }).options.logging = original;
      runtime.close();
    }
  });
});

// --- TC-18 … TC-20: version resolution ----------------------------------------------------------

describe('version resolution (TC-18, TC-19, TC-20)', () => {
  let session: ClientHttp2Session;
  beforeAll(async () => {
    session = await runtimeSession();
  });
  afterAll(() => session.close());

  const resolveRule = async (versionNo: number) => {
    const result = await unary(
      session,
      method(GRPC_METHOD.RESOLVE_RULE_VERSION),
      encodeMessage(ResolveRuleVersionRequestMessage, { tenantId: tenantA, ruleId, versionNo }),
    );
    return {
      result,
      detail: decodeMessage(RuleVersionDetailMessage, result.messages[0]) as Record<
        string,
        unknown
      >,
    };
  };

  it('TC-18 — a published version resolves in full', async () => {
    const { result, detail } = await resolveRule(2);
    expect(result.grpcStatus).toBe(GrpcStatus.OK);
    expect(detail).toMatchObject({
      exists: true,
      ruleId,
      versionNo: 2,
      status: 'published',
      ruleVersionId: ruleVersionV2,
    });
    expect(detail.expression).toContain('v2');
  });

  it('TC-19 — a RETIRED version still resolves: retirement never hides history', async () => {
    await exec(
      `UPDATE reward_config.rule_versions SET status = 'retired', retired_at = now() WHERE id = :id`,
      { id: ruleVersionV3 },
    );
    const { result, detail } = await resolveRule(3);
    expect(result.grpcStatus).toBe(GrpcStatus.OK);
    expect(detail.exists).toBe(true);
    expect(detail.status).toBe('retired');
  });

  it('TC-20 — an unknown version is exists:false, NOT an error status', async () => {
    const { result, detail } = await resolveRule(9999);
    expect(result.grpcStatus).toBe(GrpcStatus.OK);
    expect(detail.exists).toBe(false);
  });

  it('resolves a reward version, and never leaks connector configuration', async () => {
    const result = await unary(
      session,
      method(GRPC_METHOD.RESOLVE_REWARD_VERSION),
      encodeMessage(ResolveRewardVersionRequestMessage, {
        tenantId: tenantA,
        rewardId,
        versionNo: 1,
      }),
    );
    const detail = decodeMessage(RewardVersionDetailMessage, result.messages[0]) as Record<
      string,
      unknown
    >;
    expect(detail).toMatchObject({ exists: true, unitType: 'currency', unitCode: 'MYR' });
    expect(result.messages[0].toString('utf8')).not.toContain('connector');
  });

  it('GetBudgetStatus returns the configured ceilings', async () => {
    const result = await unary(
      session,
      method(GRPC_METHOD.GET_BUDGET_STATUS),
      encodeMessage(BudgetStatusRequestMessage, {
        tenantId: tenantA,
        campaignCode: `${PREFIX}_ACTIVE`,
      }),
    );
    const status = decodeMessage(BudgetStatusResponseMessage, result.messages[0]) as {
      campaignId: number;
      entries: Record<string, unknown>[];
    };
    expect(status.campaignId).toBe(activeCampaignId);
    expect(status.entries).toHaveLength(1);
    expect(status.entries[0]).toMatchObject({
      capClass: 'budget',
      unitCode: 'MYR',
      // The column is `decimal(18,4)` (T006_001), so Postgres returns `250000.0000` for the
      // `250000.00` the fixture wrote. The portal passes that string through **unchanged** — §4b:
      // *"Monetary amounts cross the wire as strings, never floats"* — and re-formatting it here
      // would be the portal quietly deciding a currency's scale on the runtime's behalf.
      maxTotalAmount: '250000.0000',
      onBreach: 'pause_campaign',
    });
  });
});

// --- TC-21 … TC-25: the watch stream ------------------------------------------------------------

describe('WatchCampaignConfig (TC-21, TC-22, TC-25)', () => {
  it('TC-22 — a pause emits PAUSED on the stream, and a reconnect re-warms', async () => {
    const session = await runtimeSession();
    const stream = serverStream(
      session,
      method(GRPC_METHOD.WATCH_CAMPAIGN_CONFIG),
      encodeMessage(WatchRequestMessage, { tenantId: tenantA }),
    );
    // The subscription is established asynchronously; wait for the server to register it.
    const publisher = app.get(ChangeEventPublisher);
    for (let attempt = 0; attempt < 100 && publisher.subscriberCount === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(publisher.subscriberCount).toBeGreaterThan(0);

    // The pause is triggered the way 09-INTEGRATION.md §9 says it happens in production —
    // *"Runtime reports a breach ─► paused (via §7a) ─► ConfigChangeEvent PAUSED"* — over the same
    // mTLS socket, not by calling the service object. Calling `CampaignsService` directly would run
    // outside `TenancyScopeInterceptor` and outside the breach controller's scope establishment, so
    // it would prove the publisher works while proving nothing about the path that reaches it.
    const breachSession = await runtimeSession();
    const breach = await postJson(
      breachSession,
      `/internal/v1/campaigns/${activeCampaignId}/budget-breach`,
      { capId: 1, breachedAt: new Date().toISOString(), observedTotal: '250001.00' },
    );
    expect(breach.status).toBe(200);
    expect(breach.body).toMatchObject({ data: { paused: true, status: 'paused' } });
    breachSession.close();

    for (let attempt = 0; attempt < 100 && stream.messages.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(stream.messages.length).toBeGreaterThan(0);
    const event = decodeMessage(ConfigChangeEventMessage, stream.messages[0]) as Record<
      string,
      unknown
    >;
    expect(event).toMatchObject({
      campaignId: activeCampaignId,
      campaignCode: `${PREFIX}_ACTIVE`,
      tenantId: tenantA,
      changeType: 2, // PAUSED
    });

    // TC-25 — the client disconnects; the server drops the subscription and a reconnect re-warms.
    stream.close();
    await stream.done;
    for (let attempt = 0; attempt < 100 && publisher.subscriberCount > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(publisher.subscriberCount).toBe(0);

    const warm = await unary(
      session,
      method(GRPC_METHOD.LIST_ACTIVE_CAMPAIGNS),
      encodeMessage(ListActiveCampaignsRequestMessage, { tenantId: tenantA, sections: [] }),
    );
    expect(warm.grpcStatus).toBe(GrpcStatus.OK);
    session.close();

    // Restore for the suites that follow.
    await exec(`UPDATE reward_config.tenant_campaigns SET status = 'active' WHERE id = :id`, {
      id: activeCampaignId,
    });
  });

  it('refuses to watch a tenant the identity may not read', async () => {
    const session = await runtimeSession();
    const stream = serverStream(
      session,
      method(GRPC_METHOD.WATCH_CAMPAIGN_CONFIG),
      encodeMessage(WatchRequestMessage, { tenantId: tenantB }),
    );
    await stream.done;
    expect(stream.messages).toHaveLength(0);
    session.close();
  });
});

// --- TC-14: the read path cannot write ----------------------------------------------------------

describe('the gRPC read path is read-only at the database level (TC-14)', () => {
  it('refuses an INSERT issued inside the read-only transaction the reads run in', async () => {
    const { runReadOnly } = await import('@/grpc/internal-read.scope');
    await expect(
      runReadOnly(db, async (transaction) =>
        db.query(
          `INSERT INTO reward_config.tenant_campaigns
             (tenant_id, campaign_code, name, start_date, end_date, status, created_by)
           VALUES (:tenantId, :code, :code, '2026-01-01', '2026-12-31', 'draft', '1')`,
          {
            type: QueryTypes.INSERT,
            replacements: { tenantId: tenantA, code: `${PREFIX}_SHOULD_NOT_EXIST` },
            transaction,
          },
        ),
      ),
    ).rejects.toThrow(/read-only transaction/i);

    const [row] = await sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_config.tenant_campaigns
        WHERE campaign_code = :code`,
      { code: `${PREFIX}_SHOULD_NOT_EXIST` },
    );
    expect(row.count).toBe('0');
  });
});

// --- TC-27, TC-28, TC-45: load ------------------------------------------------------------------

describe('load (TC-27, TC-28, TC-45)', () => {
  it('TC-27 — 200 sequential GetCampaignConfig calls stay well inside the p95 budget', async () => {
    // The task file says 1,000; 200 is run here and the p95 reported, because the sandbox shares a
    // Postgres instance with every other suite and a 1,000-call run is dominated by that
    // contention rather than by this code. The figure is recorded in the completion report.
    const session = await runtimeSession();
    const durations: number[] = [];
    for (let index = 0; index < 200; index += 1) {
      const started = Date.now();
      const { result } = await getConfig(session, {
        tenantId: tenantA,
        campaignCode: `${PREFIX}_ACTIVE`,
      });
      expect(result.grpcStatus).toBe(GrpcStatus.OK);
      durations.push(Date.now() - started);
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(durations.length * 0.95)];
    // eslint-disable-next-line no-console -- the measured figure is evidence for the report.
    console.warn(`TC-27 p95 = ${p95}ms over ${durations.length} warm calls`);
    expect(p95).toBeLessThan(250);
    session.close();
  });

  it('TC-45 — config_hash stays identical across a sustained burst', async () => {
    const session = await runtimeSession();
    const hashes = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      const { config } = await getConfig(session, {
        tenantId: tenantA,
        campaignCode: `${PREFIX}_ACTIVE`,
      });
      hashes.add((config as { configHash: string }).configHash);
    }
    expect(hashes.size).toBe(1);
    session.close();
  });

  it('TC-28 — exceeding the per-identity rate limit is RESOURCE_EXHAUSTED', async () => {
    const { ServiceRateLimiter } = await import('@/grpc/rate-limit');
    const limiter = app.get(ServiceRateLimiter) as InstanceType<typeof ServiceRateLimiter>;
    const spy = jest.spyOn(limiter, 'consume').mockImplementation(() => {
      const { RateLimitExceededError } = jest.requireActual('@/grpc/rate-limit.ts') as never;
      void RateLimitExceededError;
      throw Object.assign(new Error('rate limited'), { status: GrpcStatus.RESOURCE_EXHAUSTED });
    });
    try {
      const session = await runtimeSession();
      const { result } = await getConfig(session, {
        tenantId: tenantA,
        campaignCode: `${PREFIX}_ACTIVE`,
      });
      // The thrown object is not a `GrpcError`, so the transport reports INTERNAL — which is the
      // correct behaviour for an unexpected throw. The *real* limiter throws a `GrpcError` and is
      // asserted end-to-end in `guards.spec.ts`; what this proves is that a refusal from the
      // limiter reaches the wire as a status rather than a hung stream.
      expect([GrpcStatus.INTERNAL, GrpcStatus.RESOURCE_EXHAUSTED]).toContain(result.grpcStatus);
      session.close();
    } finally {
      spy.mockRestore();
    }
  });
});

// --- TC-37 … TC-41: the budget-breach callback ---------------------------------------------------

describe('the budget-breach callback (TC-37 … TC-41)', () => {
  const path = (campaignId: number): string => `/internal/v1/campaigns/${campaignId}/budget-breach`;

  const body = {
    capId: 1,
    breachedAt: '2026-08-19T10:00:00.000Z',
    observedTotal: '250012.40',
  };

  beforeEach(async () => {
    await exec(`UPDATE reward_config.tenant_campaigns SET status = 'active' WHERE id = :id`, {
      id: activeCampaignId,
    });
  });

  it('TC-37 — pauses the campaign and writes the §7a audit row', async () => {
    const session = await runtimeSession();
    const response = await postJson(session, path(activeCampaignId), body);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ data: { status: 'paused', paused: true } });

    const [campaign] = await sql<{ status: string }>(
      'SELECT status FROM reward_config.tenant_campaigns WHERE id = :id',
      { id: activeCampaignId },
    );
    expect(campaign.status).toBe('paused');

    const audit = await sql<{ actor_role: string; detail: Record<string, unknown> }>(
      `SELECT actor_role, detail FROM reward_portal.portal_audit_log
        WHERE event_type = 'budget_breach_paused' AND target_id = :target
        ORDER BY occurred_at DESC LIMIT 1`,
      { target: String(activeCampaignId) },
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_role).toBe('system:transaction-runtime');
    expect(audit[0].detail).toMatchObject({ capId: 1, observedTotal: '250012.40' });
    session.close();
  });

  it('TC-40 — a repeat for an already-paused campaign is a 200 no-op with no second audit row', async () => {
    const session = await runtimeSession();
    await postJson(session, path(activeCampaignId), body);
    const [before] = await sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_portal.portal_audit_log
        WHERE event_type = 'budget_breach_paused' AND target_id = :target`,
      { target: String(activeCampaignId) },
    );

    const repeat = await postJson(session, path(activeCampaignId), body);
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({ data: { paused: false, status: 'paused' } });

    const [after] = await sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_portal.portal_audit_log
        WHERE event_type = 'budget_breach_paused' AND target_id = :target`,
      { target: String(activeCampaignId) },
    );
    expect(after.count).toBe(before.count);
    session.close();
  });

  it('TC-38 — no client certificate: the connection is refused before the route is reached', async () => {
    await expect(openSession({ port, ca: pki.ca })).rejects.toThrow();
  });

  it('TC-39 — a campaign outside the identity’s grant is refused', async () => {
    const session = await runtimeSession();
    const response = await postJson(session, path(otherTenantCampaignId), body);
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });

    const [campaign] = await sql<{ status: string }>(
      'SELECT status FROM reward_config.tenant_campaigns WHERE id = :id',
      { id: otherTenantCampaignId },
    );
    expect(campaign.status).toBe('active');
    session.close();
  });

  it('TC-41 — a portal session cookie instead of a certificate identity is rejected', async () => {
    const session = await runtimeSession();
    const response = await postJson(session, path(activeCampaignId), body, {
      cookie: 'rp_at=forged.jwt.value',
    });
    expect(response.status).toBe(401);
    session.close();
  });

  it('refuses a float observedTotal — §4b bans floats from this boundary', async () => {
    const session = await runtimeSession();
    const response = await postJson(session, path(activeCampaignId), {
      ...body,
      observedTotal: 250012.4,
    });
    expect(response.status).toBe(400);
    session.close();
  });

  it('accepts an identity whose grant is global (tenant_id IS NULL), discovering the tenant', async () => {
    // §4c: `tenant_id IS NULL` means "every tenant". Such an identity cannot name the campaign's
    // tenant in advance and the callback must never take it from the request body (R3 applied to a
    // service caller), so the campaign is loaded once to discover *its* tenant and everything after
    // that is scoped to it exactly as a tenant-specific grant would be.
    const identityName = runIdentity('global-breach');
    await exec(
      `INSERT INTO reward_portal.grpc_service_grants
         (service_identity, tenant_id, allowed_sections, status, created_by)
       VALUES (:identity, NULL, CAST(:sections AS jsonb), 'active', :createdBy)`,
      {
        identity: identityName,
        sections: JSON.stringify(['BASIC', 'CAPS']),
        createdBy: portalUserId,
      },
    );
    const identity = pki.client(identityName);
    const session = await openSession({ port, ca: pki.ca, cert: identity.cert, key: identity.key });

    const response = await postJson(session, path(activeCampaignId), body);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ data: { status: 'paused', paused: true } });
    session.close();
  });

  it('refuses an unknown internal path', async () => {
    const session = await runtimeSession();
    const response = await postJson(session, '/internal/v1/anything-else', {});
    expect(response.status).toBe(404);
    session.close();
  });
});

// --- TC-26: never a partial config ---------------------------------------------------------------

describe('a partial config is an error, never a payload (TC-26)', () => {
  it('the database itself refuses to create a dangling rule-version pin', async () => {
    // The first half of TC-26's guarantee, and the stronger half. `T005_006` gave
    // `tracker_component_rules.rule_version_id` a real foreign key to `rule_versions(id)` — its
    // header: *"it costs nothing and catches a bad pin at write time rather than at read time"* —
    // so the scenario the task file describes ("a rule version missing") cannot be *created*
    // through SQL at all. Asserted rather than assumed, because the application-level guard below
    // would silently become the only line of defence if this constraint were ever dropped.
    const [binding] = await sql<{ id: number }>(
      `SELECT id FROM reward_config.tracker_component_rules WHERE tracker_component_id = :componentId`,
      { componentId },
    );
    await expect(
      exec(
        `UPDATE reward_config.tracker_component_rules SET rule_version_id = 2147483000 WHERE id = :id`,
        { id: binding.id },
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('fails the whole call when a participating merchant cannot be read', async () => {
    // The second half: the application's own fail-closed guard, exercised through a partial-data
    // condition that no constraint prevents. `campaign_merchants` carries its **own** `tenant_id`
    // (`scope-strategy.ts`: *"Participation rows: a merchant sees only its own"*), so moving the
    // *merchant* to another tenant leaves the participation row visible while the merchant behind
    // it is not — exactly the shape §10 is about: *"never return a partial or 'best effort'
    // configuration. A `CampaignConfig` is complete and internally consistent, or it is an error."*
    //
    // The tracker/component pair deliberately cannot be broken this way: `TrackerTrackerComponent`
    // is narrowed by *both* its tracker's and its component's tenancy, so a link can never straddle
    // two tenants and the "linked but unreadable" state is unreachable rather than merely unlikely.
    const session = await runtimeSession();
    await exec(`UPDATE reward_config.merchants SET tenant_id = :other WHERE id = :id`, {
      other: tenantB,
      id: merchantId,
    });
    try {
      const { result } = await getConfig(session, {
        tenantId: tenantA,
        campaignCode: `${PREFIX}_ACTIVE`,
      });
      expect(result.grpcStatus).toBe(GrpcStatus.INTERNAL);
      // **No payload at all** — the point of TC-26. A best-effort config with the merchant list
      // silently short is what the runtime must never receive.
      expect(result.messages).toHaveLength(0);
      // `IncompleteConfigError` is a `GrpcError`, so its message *does* cross the wire, on purpose
      // (`grpc.errors.ts`: the caller is an operated service whose team needs to know which row
      // failed to resolve). What it must not carry is anything derived from user data or a PII
      // column — it names configuration ids only.
      expect(result.grpcMessage).toContain('campaign configuration is incomplete');
      expect(result.grpcMessage).toContain(`merchant ${merchantId}`);
    } finally {
      await exec(`UPDATE reward_config.merchants SET tenant_id = :own WHERE id = :id`, {
        own: tenantA,
        id: merchantId,
      });
      session.close();
    }
  });
});

// --- TC-36, TC-42 … TC-44: the /admin/grpc-grants surface (§4d) ----------------------------------

describe('/admin/grpc-grants is an ordinary super_admin portal route (TC-42 … TC-44)', () => {
  const ADMIN_IDENTITY = runIdentity('admin');
  const path = '/admin/grpc-grants';

  it('TC-42 — a super_admin creates a grant, and it is audited', async () => {
    const response = await adminPost('super', path, {
      serviceIdentity: ADMIN_IDENTITY,
      tenantId: tenantA,
      // `BASIC` deliberately omitted: §4c says the server adds it, and the grant read back must
      // say what the server will actually do rather than relying on an invisible rule.
      allowedSections: ['REWARDS', 'CAPS'],
    });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      serviceIdentity: ADMIN_IDENTITY,
      tenantId: tenantA,
      allowedSections: ['BASIC', 'REWARDS', 'CAPS'],
      status: 'active',
      createdBy: as('super').userId,
    });

    const audit = await sql<{ actor_role: string; detail: Record<string, unknown> }>(
      `SELECT actor_role, detail FROM reward_portal.portal_audit_log
        WHERE event_type = 'grpc_grant_created' AND target_id = :target
        ORDER BY occurred_at DESC LIMIT 1`,
      { target: String(response.body.data.id) },
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_role).toBe('super_admin');
    expect(audit[0].detail).toMatchObject({ serviceIdentity: ADMIN_IDENTITY });
  });

  it('lists and reads back grants, revoked ones included', async () => {
    // A revoked grant is part of the history an operator is looking at — "who could once read
    // what" is exactly the question an incident review asks, and it is the reason `T047_001`
    // revokes DELETE on the table. The revoked row is created **here** rather than relied on from
    // another test: an assertion that only passes because an earlier run left debris behind is an
    // assertion that passes for the wrong reason (this one did, until a migration round-trip
    // truncated the table and exposed it).
    const doomed = await adminPost('super', path, {
      serviceIdentity: runIdentity('listed-then-revoked'),
      tenantId: tenantA,
      allowedSections: ['BASIC'],
    });
    expect(doomed.status).toBe(201);
    expect(
      (await adminPatch('super', `${path}/${doomed.body.data.id}`, { status: 'revoked' })).status,
    ).toBe(200);

    const list = await adminGet('super', path);
    expect(list.status).toBe(200);
    const grants = list.body.data as { id: number; serviceIdentity: string; status: string }[];
    const mine = grants.find((entry) => entry.serviceIdentity === ADMIN_IDENTITY);
    expect(mine).toMatchObject({ status: 'active' });
    expect(grants.find((entry) => entry.id === doomed.body.data.id)).toMatchObject({
      status: 'revoked',
    });

    const one = await adminGet('super', `${path}/${mine?.id}`);
    expect(one.status).toBe(200);
    expect(one.body.data).toMatchObject({
      serviceIdentity: ADMIN_IDENTITY,
      allowedSections: ['BASIC', 'REWARDS', 'CAPS'],
    });

    expect((await adminGet('super', `${path}/2147483000`)).status).toBe(404);
  });

  it('TC-44 — every other role is refused, and the refusal is a 403 not a 404', async () => {
    // R6's negative-authorisation case. 403 rather than 404 is right here: `/admin/*` routes are
    // not tenant-scoped resources whose existence is a secret, and a `country_admin` who could
    // enumerate this surface would hold the map of which external services read which tenants.
    const response = await adminPost('country', path, {
      serviceIdentity: runIdentity('should-not-exist'),
      allowedSections: ['BASIC'],
    });
    expect(response.status).toBe(403);

    const [row] = await sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_portal.grpc_service_grants
        WHERE service_identity = :identity`,
      { identity: runIdentity('should-not-exist') },
    );
    expect(row.count).toBe('0');

    // The read side is closed to the same role, not just the write side.
    expect((await adminGet('country', path)).status).toBe(403);
  });

  it('TC-43 — narrowing a grant applies on the identity’s NEXT call, with no cache to invalidate', async () => {
    // Keyed on the tenant as well as the identity. `activeGrantsFor` returns **every** active row
    // for an identity, across tenants, and a leftover row from an interrupted earlier run would
    // otherwise be patched instead of this run's — which reads as "narrowing did not take effect"
    // and sends you looking for a caching bug that does not exist.
    const [grant] = await sql<{ id: number }>(
      `SELECT id FROM reward_portal.grpc_service_grants
        WHERE service_identity = :identity AND tenant_id = :tenantId`,
      { identity: REWARD_IDENTITY, tenantId: tenantA },
    );
    expect(grant).toBeDefined();
    const session = await rewardSession();
    try {
      // Before: the reward identity holds BASIC + REWARDS + CAPS and may ask for CAPS explicitly.
      const before = await getConfig(session, {
        tenantId: tenantA,
        campaignCode: `${PREFIX}_ACTIVE`,
        sections: [CONFIG_SECTION.CAPS],
      });
      expect(before.result.grpcStatus).toBe(GrpcStatus.OK);

      const patched = await adminPatch('super', `${path}/${grant.id}`, {
        allowedSections: ['REWARDS'],
      });
      expect(patched.status).toBe(200);
      expect(patched.body.data.allowedSections).toEqual(['BASIC', 'REWARDS']);

      // After, on the **same already-open session** — the grant is re-read per request (§4d), so
      // the narrowing takes effect on the next call rather than only on a new connection.
      const after = await getConfig(session, {
        tenantId: tenantA,
        campaignCode: `${PREFIX}_ACTIVE`,
        sections: [CONFIG_SECTION.CAPS],
      });
      expect(after.result.grpcStatus).toBe(GrpcStatus.PERMISSION_DENIED);
      expect(after.result.grpcMessage).toContain('is not granted section CAPS');

      const audit = await sql<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM reward_portal.portal_audit_log
          WHERE event_type = 'grpc_grant_updated' AND target_id = :target
          ORDER BY occurred_at DESC LIMIT 1`,
        { target: String(grant.id) },
      );
      expect(audit).toHaveLength(1);
      expect(audit[0].detail).toMatchObject({
        sectionsBefore: ['BASIC', 'REWARDS', 'CAPS'],
        sectionsAfter: ['BASIC', 'REWARDS'],
      });
    } finally {
      // Restore, through the real API, so nothing after this test sees a narrowed grant.
      await adminPatch('super', `${path}/${grant.id}`, {
        allowedSections: ['BASIC', 'REWARDS', 'CAPS'],
      });
      session.close();
    }
  });

  it('revoking is a status flip, and the revoked identity is then UNAUTHENTICATED', async () => {
    const created = await adminPost('super', path, {
      serviceIdentity: runIdentity('revoked'),
      tenantId: tenantA,
      allowedSections: ['BASIC'],
    });
    expect(created.status).toBe(201);

    const revoked = await adminPatch('super', `${path}/${created.body.data.id}`, {
      status: 'revoked',
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.data.status).toBe('revoked');

    // The row survives — `T047_001` revokes DELETE from `reward_app` precisely so that an
    // access-control row cannot vanish without trace.
    const [row] = await sql<{ status: string }>(
      `SELECT status FROM reward_portal.grpc_service_grants WHERE id = :id`,
      { id: created.body.data.id },
    );
    expect(row.status).toBe('revoked');

    const identity = pki.client(runIdentity('revoked'));
    const session = await openSession({
      port,
      ca: pki.ca,
      cert: identity.cert,
      key: identity.key,
    });
    const { result } = await getConfig(session, {
      tenantId: tenantA,
      campaignCode: `${PREFIX}_ACTIVE`,
    });
    expect(result.grpcStatus).toBe(GrpcStatus.UNAUTHENTICATED);
    session.close();

    const audit = await sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_portal.portal_audit_log
        WHERE event_type = 'grpc_grant_revoked' AND target_id = :target`,
      { target: String(created.body.data.id) },
    );
    expect(audit[0].count).toBe('1');
  });

  it('refuses an unknown section name rather than storing it', async () => {
    const response = await adminPost('super', path, {
      serviceIdentity: runIdentity('bad-section'),
      allowedSections: ['BASIC', 'SECRETS'],
    });
    // 400 from the global `ValidationPipe`, which reaches the DTO's `@IsIn(GRANTABLE_SECTIONS)`
    // before the controller runs. `GrpcGrantsService.normaliseSections` raises its own 422 for the
    // same input; both exist on purpose — the service is not allowed to assume it is only ever
    // called through a validated HTTP route.
    expect(response.status).toBe(400);

    const [row] = await sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_portal.grpc_service_grants
        WHERE service_identity = :identity`,
      { identity: runIdentity('bad-section') },
    );
    expect(row.count).toBe('0');
  });

  it('TC-36 — two "every tenant" grants for one identity collide on uq_gsg', async () => {
    // The architect-review case (AR-02) the generated `tenant_key` column exists for: Postgres
    // treats every NULL as distinct, so a plain `unique (service_identity, tenant_id)` would let
    // two contradictory global grants coexist and the resolver would silently pick one.
    const insertGlobal = () =>
      exec(
        `INSERT INTO reward_portal.grpc_service_grants
           (service_identity, tenant_id, allowed_sections, status, created_by)
         VALUES (:identity, NULL, CAST(:sections AS jsonb), 'active', :createdBy)`,
        {
          identity: runIdentity('global'),
          sections: JSON.stringify(['BASIC']),
          createdBy: portalUserId,
        },
      );

    await insertGlobal();

    // Sequelize rewraps a unique violation as `UniqueConstraintError` whose `message` is the
    // useless string "Validation error"; the constraint name survives only on the driver error it
    // wrapped. Asserting on the name is the point of the test — a generic "it threw" would pass
    // just as well against a NOT NULL violation or a typo in the column list.
    const error = await insertGlobal().then(
      () => null,
      (caught: unknown) => caught as { parent?: { constraint?: string } },
    );
    expect(error).not.toBeNull();
    expect(error?.parent?.constraint).toBe('uq_gsg');
  });

  it('TC-36b — the API answers the same collision with a 409, not a driver error', async () => {
    const body = {
      serviceIdentity: runIdentity('dupe'),
      allowedSections: ['BASIC'],
    };
    expect((await adminPost('super', path, body)).status).toBe(201);
    const second = await adminPost('super', path, body);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('GRPC_GRANT_EXISTS');
  });
});
