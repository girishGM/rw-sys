/**
 * T-166 — **verification steps 2 and 3**: a real Maker attach, through the portal's own
 * `POST /campaigns/:id/rewards`, against a **really running promo-code-service**, with a real row
 * left in that service's own `campaign_promo_config` table.
 *
 * ### Why this file exists when three other suites already cover the same path
 *
 * Each of the existing ones stops one step short of the thing that can actually be wrong:
 *
 * - `bindings.service.spec.ts` proves what `BindingsService` hands the client (faked repository).
 * - `t127-promo-code-attach.e2e-spec.ts` proves what leaves the portal over a real socket — but the
 *   far end is a **stub**, and a stub agrees with whatever the portal sends by construction
 *   (AGENT-PROTOCOL §3: *"if the specified value were wrong, would this test still pass?"* — for a
 *   stub, always yes).
 * - `t170-promo-code-bind-live.e2e-spec.ts` proves the real service accepts the body — but it calls
 *   `PromoCodeServiceClient` directly, not the portal's endpoint, with hand-written ids.
 *
 * T-170's completion report records the gap that leaves (its D-1): *no single process has ever
 * driven `POST /campaigns/:id/rewards` at the real service.* Its stated obstacle was that the real
 * service needs an `ACTIVE` config whose `tenant_id` matches the portal's dynamically-created
 * fixture tenant, which looked like "a portal test writing into another service's schema". It is
 * not: promo-code-service has a **documented admin API** for exactly that (`04-API-CONTRACT.md`
 * §3), so this suite creates its config the way an operator would — over HTTP, authenticated, and
 * archives it again in teardown. Nothing here writes to the `promo_code` schema; the one direct
 * query into it is the read-only `SELECT` that verification step 2 asks for by name.
 *
 * ### What is real here
 *
 * Everything. `PromoCodeServiceClient` is **not overridden** — the app resolves the production
 * provider, which reads `PROMO_CODE_SERVICE_BASE_URL`/`PROMO_CODE_SERVICE_INTERNAL_TOKEN` from
 * `.env.development` exactly as a deployed portal reads them from its environment. This is the only
 * suite in the repo where the promo-code bind path has no substitution in it at all.
 *
 * ### Running it
 *
 * ```bash
 * # promo-code-service, migrated and seeded, in another shell:
 * cd promo-code-service && npm run start          # or: node dist/main.js
 *
 * cd portal/back-end
 * RUN_PROMO_CODE_LIVE=1 npm run test:e2e -- t166-attach-live          # step 2: service UP
 *
 * # then stop promo-code-service (lsof -ti :3010 | xargs kill) and:
 * RUN_PROMO_CODE_LIVE=1 PROMO_CODE_LIVE_MODE=down \
 *   npm run test:e2e -- t166-attach-live                              # step 3: service DOWN
 * ```
 *
 * Without `RUN_PROMO_CODE_LIVE=1` the whole suite skips itself, like `RUN_UI_VERIFICATION`
 * elsewhere in this repo: CI has no promo-code-service, and a suite that fails because a dependency
 * is not running teaches nobody anything.
 *
 * `PROMO_CODE_LIVE_MODE=down` is a **deliberately explicit** switch rather than a reachability
 * probe that quietly picks a mode. In `down` mode the suite first proves the service really is
 * unreachable and fails if it is not — so "step 3 passed" can never mean "step 3 was skipped".
 *
 * ### Isolation
 *
 * Fixtures are prefixed `T166E2E`, actors are named `T-166 …`, and `purgeSuiteResidue` (T-132)
 * clears this suite's residue — and only this suite's — before and after the run. The `afterAll`
 * ordering constraint (everything touching `db` runs **before** `app.close()`) is T-145's, and is
 * copied deliberately; see `t127-promo-code-attach.e2e-spec.ts`'s teardown for the full story.
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
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
import { createMigrationConnection } from '@/database/migration-connection';
import { loginCompletingMfa } from '../auth/support/super-admin-mfa';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  keyIdsFor,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import {
  clearProvidedKeyMaterial,
  provideMissingKeyMaterial,
} from '../campaigns/support/foreign-key-material';
import { purgeSuiteResidue } from '../campaigns/support/purge-suite-residue';

jest.setTimeout(600_000);

const LIVE = process.env.RUN_PROMO_CODE_LIVE === '1';
/** `up` (default) = verification step 2. `down` = verification step 3. */
const DOWN = process.env.PROMO_CODE_LIVE_MODE === 'down';

/** Where the *test* reaches promo-code-service to set its fixture up. The **portal** reads its own
 * copy of this from `.env.development`; the two are asserted equal in `beforeAll`, because a suite
 * that seeded one service and exercised another would pass for the wrong reason. */
const SERVICE_URL = process.env.PROMO_CODE_LIVE_URL ?? 'http://localhost:3010';
const SERVICE_TOKEN = process.env.PROMO_CODE_LIVE_TOKEN ?? 'throwaway-local-dev-value';

const SUITE = 't166';
const PASSWORD = 'correct horse battery staple 27!';
const PREFIX = 'T166E2E';
const COUNTRY_CODE = 'S8';
const USER_DISPLAY_PREFIX = 'T-166';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;
let borrowedKeyVars: string[] = [];

let adminUserId: number;
let countryId: number;
let tenantId: number;
let promoPolicyId: number;
let makerUserId: number;
let makerJar: string;
let makerCsrf: string;

/** The `promo_code_config` this suite creates over promo-code-service's own admin API, archived
 * again in teardown. `''` in `down` mode, where the service cannot be asked for one. */
let liveConfigId = '';

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
  try {
    await db.query(statement, { type: QueryTypes.RAW, replacements });
  } catch (error) {
    // A Sequelize error thrown inside `beforeAll` reaches Jest's reporter with an empty `message`
    // and no SQL. Naming the statement is the difference between "all failed" and a diagnosis.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `fixture statement failed:\n${statement}\n→ ${reason === '' ? String(error) : reason}`,
      {
        cause: error,
      },
    );
  }
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

function post(path: string, body: unknown = {}) {
  return http()
    .post(`/api/v1${path}`)
    .set('Cookie', makerJar)
    .set('X-CSRF-Token', makerCsrf)
    .send(body as object);
}

// --- portal fixtures -----------------------------------------------------------------------------

async function ensureAdminUserId(): Promise<number> {
  const [row] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.admin_users ORDER BY id LIMIT 1',
  );
  if (row === undefined) throw new Error('no admin_users rows — cannot author fixture versions');
  return row.id;
}

async function ensureCountry(): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.countries WHERE code = :code',
    { code: COUNTRY_CODE },
  );
  if (existing !== undefined) {
    await exec(`UPDATE reward_config.countries SET status = 'active' WHERE id = :id`, {
      id: existing.id,
    });
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.countries (code, name, timezone, currency_code, dialing_code, status)
     VALUES (:code, 'T-166 e2e country', 'Asia/Kuala_Lumpur', 'MYR', '+061', 'active') RETURNING id`,
    { code: COUNTRY_CODE },
  );
  return created.id;
}

async function ensureTenant(): Promise<number> {
  const code = `${PREFIX}_TENANT`;
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

async function ensureRewardSystem(): Promise<number> {
  const code = `${PREFIX}_RWD_PROMO`;
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.reward_systems WHERE system_code = :code',
    { code },
  );
  const rewardId =
    existing?.id ??
    (
      await sql<{ id: number }>(
        `INSERT INTO reward_config.reward_systems
           (tenant_id, system_code, name, reward_type, connector_type, status)
         VALUES (NULL, :code, :code, 'voucher', 'internal', 'active') RETURNING id`,
        { code },
      )
    )[0].id;

  const [assignment] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.reward_country_assignments
      WHERE reward_id = :rewardId AND country_id = :countryId`,
    { rewardId, countryId },
  );
  if (assignment === undefined) {
    await exec(
      `INSERT INTO reward_config.reward_country_assignments (reward_id, country_id, assigned_by)
       VALUES (:rewardId, :countryId, :adminUserId)`,
      { rewardId, countryId, adminUserId },
    );
  }
  return rewardId;
}

/**
 * A published version carrying `reward_kind = 'PROMO_CODE'` and a campaign-level bind allowance —
 * the row `assertPromoCodeAttachable` reads. Published rather than drafted because
 * `trg_reward_versions_immutable` refuses to change the Kind afterwards, which is the control the
 * attach gate depends on (see `t127-promo-code-attach.e2e-spec.ts`'s `ensureRewardVersion`).
 */
async function ensureRewardVersion(rewardId: number): Promise<number> {
  const valueConfig = JSON.stringify({
    apiProvider: 'PROMO_CODE_CONFIG_SERVICE',
    bindLevels: ['campaign'],
  });

  const [reusable] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.reward_versions
      WHERE reward_id = :rewardId
        AND reward_kind = 'PROMO_CODE'
        AND value_config IS NOT DISTINCT FROM :valueConfig
      ORDER BY version_no DESC LIMIT 1`,
    { rewardId, valueConfig },
  );

  let versionId = reusable?.id;
  if (versionId === undefined) {
    const [next] = await sql<{ version_no: number }>(
      `SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no
         FROM reward_config.reward_versions WHERE reward_id = :rewardId`,
      { rewardId },
    );
    const [created] = await sql<{ id: number }>(
      `INSERT INTO reward_config.reward_versions
         (reward_id, version_no, unit_type, unit_code, reward_kind, value_config,
          status, created_by, published_by, published_at)
       VALUES (:rewardId, :versionNo, NULL, NULL, 'PROMO_CODE', :valueConfig,
               'published', :adminUserId, :adminUserId, now())
       RETURNING id`,
      { rewardId, versionNo: next?.version_no ?? 1, valueConfig, adminUserId },
    );
    versionId = created.id;
  }

  await exec(
    `UPDATE reward_config.reward_version_country_assignments
        SET status = 'inactive'
      WHERE reward_id = :rewardId AND reward_version_id <> :versionId`,
    { rewardId, versionId },
  );

  const [assignment] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.reward_version_country_assignments
      WHERE reward_version_id = :versionId AND country_id = :countryId`,
    { versionId, countryId },
  );
  if (assignment === undefined) {
    await exec(
      `INSERT INTO reward_config.reward_version_country_assignments
         (reward_version_id, reward_id, country_id, status, assigned_by)
       VALUES (:versionId, :rewardId, :countryId, 'active', :adminUserId)`,
      { versionId, rewardId, countryId, adminUserId },
    );
  } else {
    await exec(
      `UPDATE reward_config.reward_version_country_assignments SET status = 'active' WHERE id = :id`,
      { id: assignment.id },
    );
  }
  return versionId;
}

async function ensureRewardPolicy(rewardId: number): Promise<number> {
  const code = `${PREFIX}_POL_PROMO`;
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.reward_policies
      WHERE reward_system_id = :rewardId AND policy_code = :code`,
    { rewardId, code },
  );
  if (existing !== undefined) {
    await exec(`UPDATE reward_config.reward_policies SET config = '{}'::jsonb WHERE id = :id`, {
      id: existing.id,
    });
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.reward_policies (reward_system_id, policy_code, name, config, status)
     VALUES (:rewardId, :code, :code, '{}'::jsonb, 'active') RETURNING id`,
    { rewardId, code },
  );
  return created.id;
}

/** Puts the shared policy `config` back to `{}` so one case's pick cannot make the next one pass. */
async function resetPolicyConfig(): Promise<void> {
  await exec(`UPDATE reward_config.reward_policies SET config = '{}'::jsonb WHERE id = :id`, {
    id: promoPolicyId,
  });
}

async function policyConfig(): Promise<Record<string, unknown> | null> {
  const [row] = await sql<{ config: Record<string, unknown> | string | null }>(
    'SELECT config FROM reward_config.reward_policies WHERE id = :policyId',
    { policyId: promoPolicyId },
  );
  const raw = row?.config ?? null;
  if (raw === null) return null;
  return typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : raw;
}

/** `reward_assignment` audit rows for a campaign — scoped to that entity type because creating the
 * draft writes `campaign` rows of its own, so a bare count could never be zero. */
async function auditRowCount(campaignId: number): Promise<number> {
  const [row] = await sql<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM reward_portal.portal_campaign_audit_trail
      WHERE campaign_id = :campaignId AND entity_type = 'reward_assignment'`,
    { campaignId },
  );
  return Number(row?.count ?? '0');
}

async function assignmentCount(campaignId: number): Promise<number> {
  const rows = await sql<{ id: number }>(
    `SELECT id FROM reward_config.reward_campaign_assignments
      WHERE campaign_id = :campaignId AND reward_policy_id = :policyId`,
    { campaignId, policyId: promoPolicyId },
  );
  return rows.length;
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

let campaignSeq = 0;
async function createDraft(): Promise<number> {
  campaignSeq += 1;
  const response = await post('/campaigns', {
    campaignCode: `${PREFIX}_C${String(Date.now())}_${String(campaignSeq)}`,
    name: 'T-166 live e2e campaign',
    startDate: inDays(1),
    endDate: inDays(30),
    budgetAmount: '100000.00',
    budgetCurrency: 'MYR',
  });
  if (response.status !== 201) {
    throw new Error(`createDraft failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.data.id as number;
}

// --- promo-code-service fixtures, over its own documented admin API -------------------------------

/**
 * `04-API-CONTRACT.md` §3 — creates an `ACTIVE` recipe owned by this suite's **portal** tenant, so
 * the bind the portal is about to attempt resolves (§2's `409` is precisely "no ACTIVE config for
 * that tenant"). Over HTTP with the shared internal token: this suite never writes to the
 * `promo_code` schema.
 */
async function createLivePromoCodeConfig(): Promise<string> {
  const response = await fetch(`${SERVICE_URL}/api/v1/promo-code-configs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${SERVICE_TOKEN}` },
    body: JSON.stringify({
      tenantId: String(tenantId),
      actorId: String(makerUserId),
      // Unique per run: promo-code-service enforces `(tenant, name)` uniqueness across *archived*
      // recipes too, so a fixed name would `409` on the second run of this suite rather than on
      // anything the suite is testing.
      name: `${PREFIX} live attach config ${String(Date.now())}`,
      codeLength: 8,
      characterSet: 'ALPHANUMERIC',
      rewardValueType: 'PERCENTAGE',
      rewardValue: 10,
      rewardUnit: '%',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 201) {
    throw new Error(
      `could not create a live promo_code_config: ${String(response.status)} ${await response.text()}`,
    );
  }
  return ((await response.json()) as { id: string }).id;
}

/** Soft-archives the fixture recipe (§3 `DELETE` is an archive, never a row delete) so repeated
 * runs cannot leave a growing pile of `ACTIVE` recipes in a shared dev database. */
async function archiveLivePromoCodeConfig(): Promise<void> {
  if (liveConfigId === '') return;
  const query = `tenantId=${String(tenantId)}&actorId=${String(makerUserId)}`;
  await fetch(`${SERVICE_URL}/api/v1/promo-code-configs/${liveConfigId}?${query}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  });
}

/**
 * The `campaign_promo_config` rows promo-code-service holds for a campaign — verification step 2's
 * *"confirm a real row in promo-code-service's own `campaign_promo_config` table"*, read from the
 * table itself rather than inferred from the portal's `201`.
 *
 * A read, and only a read, through the migration connection (both services live in the same
 * `reward_system` database, in different schemas). Asserting the portal's own response instead
 * would prove only that the client did not throw — the whole point of this suite is that the row
 * exists on the other side.
 */
async function remoteBindings(
  campaignId: number,
): Promise<
  { tenant_id: string; bind_level: string; bind_ref_id: string; bound_by: string; status: string }[]
> {
  const admin = createMigrationConnection();
  try {
    return await admin.query(
      `SELECT tenant_id, bind_level, bind_ref_id, bound_by, status
         FROM promo_code.campaign_promo_config
        WHERE bind_ref_id = :bindRefId AND tenant_id = :tenantId
        ORDER BY bound_at DESC`,
      {
        type: QueryTypes.SELECT,
        replacements: { bindRefId: String(campaignId), tenantId: String(tenantId) },
      },
    );
  } finally {
    await admin.close();
  }
}

/** Proves, before any `down`-mode assertion runs, that the service really is stopped. Without this
 * a passing "step 3" could just mean someone forgot to point the suite at a dead port. */
async function assertServiceUnreachable(): Promise<void> {
  const reachable = await fetch(`${SERVICE_URL}/api/v1/promo-code-configs?tenantId=1`, {
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    signal: AbortSignal.timeout(5_000),
  })
    .then(() => true)
    .catch(() => false);
  if (reachable) {
    throw new Error(
      `PROMO_CODE_LIVE_MODE=down, but ${SERVICE_URL} answered. Stop promo-code-service first ` +
        `(lsof -ti :3010 | xargs kill) — otherwise this suite would "pass" step 3 without ever ` +
        `having a stopped service to prove anything against.`,
    );
  }
}

// --- lifecycle -----------------------------------------------------------------------------------

const describeLive = LIVE ? describe : describe.skip;

beforeAll(async () => {
  if (!LIVE) return;

  // No `.overrideProvider(PromoCodeServiceClient)` anywhere in this file — that is the point.
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

  // The portal must be aimed at the same service this suite seeds — see SERVICE_URL.
  const portalBaseUrl = process.env.PROMO_CODE_SERVICE_BASE_URL;
  if (
    portalBaseUrl !== undefined &&
    portalBaseUrl.replace(/\/+$/, '') !== SERVICE_URL.replace(/\/+$/, '')
  ) {
    throw new Error(
      `the portal is configured for ${portalBaseUrl} but this suite seeds ${SERVICE_URL} — ` +
        `set PROMO_CODE_LIVE_URL to match, or this run would prove nothing.`,
    );
  }

  await purgeSuiteResidue({ prefix: PREFIX, userDisplayNamePrefix: USER_DISPLAY_PREFIX });

  adminUserId = await ensureAdminUserId();
  countryId = await ensureCountry();
  tenantId = await ensureTenant();
  const rewardId = await ensureRewardSystem();
  await ensureRewardVersion(rewardId);
  promoPolicyId = await ensureRewardPolicy(rewardId);

  const email = `t166-e2e-maker@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);
  makerUserId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `${USER_DISPLAY_PREFIX} maker`,
    role: 'maker',
    countryId,
    tenantId,
    merchantId: null,
    mustChangePassword: false,
  });
  await exec(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    { userId: makerUserId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
  );
  const login = await loginCompletingMfa(app, { email, password: PASSWORD }, db);
  if (login.status !== 200) {
    throw new Error(`maker login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  makerJar = jarFrom(login);
  makerCsrf = cookieValue(login, CSRF_COOKIE_NAME);

  if (DOWN) {
    await assertServiceUnreachable();
  } else {
    liveConfigId = await createLivePromoCodeConfig();
  }
});

afterAll(async () => {
  if (!LIVE) return;
  // T-145 ordering: everything that queries `db` runs before `app.close()` tears that connection
  // down. `archiveLivePromoCodeConfig` talks to another process over HTTP and is placed first only
  // because it needs `tenantId`/`makerUserId`, which outlive the connection either way.
  await archiveLivePromoCodeConfig();
  await purgeSuiteResidue({ prefix: PREFIX, userDisplayNamePrefix: USER_DISPLAY_PREFIX });
  if (db !== undefined) await removeEncryptionKeys(db, SUITE);
  if (app !== undefined) await app.close();
  clearProvidedKeyMaterial(borrowedKeyVars);

  const kids = keyIdsFor(SUITE);
  const admin = createMigrationConnection();
  try {
    const rows = await admin.query<{ kid: string }>(
      `SELECT kid FROM reward_portal.encryption_keys WHERE kid IN (:kids)`,
      { type: QueryTypes.SELECT, replacements: { kids: [kids.field, kids.blindIndex] } },
    );
    if (rows.length > 0) {
      await admin.query(`DELETE FROM reward_portal.encryption_keys WHERE kid IN (:kids)`, {
        type: QueryTypes.DELETE,
        replacements: { kids: [kids.field, kids.blindIndex] },
      });
      throw new Error(
        `teardown left ${String(rows.length)} encryption_keys row(s) behind; deleted here so the ` +
          `next suite still boots, but that is damage control, not a pass (T-145).`,
      );
    }
  } finally {
    await admin.close();
  }
});

// --- verification step 2: the service is up ------------------------------------------------------

const describeUp = LIVE && !DOWN ? describe : describe.skip;

describeUp('T-166 · verification step 2 — a real attach against a real promo-code-service', () => {
  it('a Maker attaching a PROMO_CODE reward gets a 201, and the binding really exists on the other side', async () => {
    await resetPolicyConfig();
    const campaignId = await createDraft();

    // Nothing is bound for this campaign before the attach, so the row asserted below cannot be a
    // leftover from an earlier run that happened to reuse the id.
    expect(await remoteBindings(campaignId)).toHaveLength(0);

    await post(`/campaigns/${String(campaignId)}/rewards`, {
      level: 'campaign',
      rewardPolicyId: promoPolicyId,
      promoCodeConfig: liveConfigId,
    }).expect(201);

    // The portal's own record of the attach, unchanged by this task (implementation note 5).
    expect(await assignmentCount(campaignId)).toBe(1);
    expect(await policyConfig()).toEqual({ promoCodeConfig: liveConfigId });
    expect(await auditRowCount(campaignId)).toBe(1);

    // …and the thing no stub can prove: promo-code-service persisted the binding, carrying the
    // portal's own ids verbatim (T-170), reading back as this campaign, this tenant, this maker.
    const bindings = await remoteBindings(campaignId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toEqual({
      tenant_id: String(tenantId),
      bind_level: 'CAMPAIGN',
      bind_ref_id: String(campaignId),
      bound_by: String(makerUserId),
      status: 'ACTIVE',
    });
  });

  it('TC-2 live: a config the real service will not bind fails the attach with a 409 and writes nothing', async () => {
    await resetPolicyConfig();
    const campaignId = await createDraft();

    // A syntactically valid, genuinely unknown config id: §2 answers `409` because it resolves to
    // no ACTIVE config for this tenant. The stub in `t127-…e2e-spec.ts` can only be *told* to say
    // 409; here the real service decides it.
    const response = await post(`/campaigns/${String(campaignId)}/rewards`, {
      level: 'campaign',
      rewardPolicyId: promoPolicyId,
      promoCodeConfig: '00000000-0000-4000-8000-000000000000',
    }).expect(409);

    expect(response.body.error.code).toBe('PROMO_CODE_CONFIG_NOT_BINDABLE');
    expect(await assignmentCount(campaignId)).toBe(0);
    expect(await policyConfig()).toEqual({});
    expect(await auditRowCount(campaignId)).toBe(0);
    expect(await remoteBindings(campaignId)).toHaveLength(0);
  });
});

// --- verification step 3: the service is stopped -------------------------------------------------

const describeDown = LIVE && DOWN ? describe : describe.skip;

describeDown('T-166 · verification step 3 — promo-code-service stopped', () => {
  it('the same attach is a 502, and the portal writes nothing at all', async () => {
    await resetPolicyConfig();
    const campaignId = await createDraft();

    const response = await post(`/campaigns/${String(campaignId)}/rewards`, {
      level: 'campaign',
      rewardPolicyId: promoPolicyId,
      // Any config id: the call never reaches a service that could judge it.
      promoCodeConfig: '00000000-0000-4000-8000-000000000000',
    }).expect(502);

    expect(response.body.error.code).toBe('PROMO_CODE_SERVICE_BIND_FAILED');
    // The four things a successful attach writes, none of them present — this is the fail-closed
    // ordering the task exists to guarantee, observed through the real endpoint.
    expect(await assignmentCount(campaignId)).toBe(0);
    expect(await policyConfig()).toEqual({});
    expect(await auditRowCount(campaignId)).toBe(0);
  });
});

// A file whose every `describe` is `describe.skip` is an empty suite, which Jest fails outright.
describeLive('T-166 live e2e', () => {
  it('is opt-in', () => {
    expect(LIVE).toBe(true);
  });
});

if (!LIVE) {
  describe('T-166 live e2e', () => {
    it.skip('skipped — set RUN_PROMO_CODE_LIVE=1 with promo-code-service running (see file header)', () => {
      // Intentionally empty: the header documents how to run it.
    });
  });
}
