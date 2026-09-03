/**
 * T-127 — the Promo Code attach flow against the **real** Postgres instance, through the real
 * `AppModule`, over real HTTP.
 *
 * ### Why this file exists on top of `t127-promo-code-attach.spec.ts`
 *
 * That suite proves the service's decisions with a faked repository. Three of this task's claims
 * are not decisions and cannot be proved that way (AGENT-PROTOCOL §3, *"assert the observable
 * property, not the implementation string"*):
 *
 * - **TC-5** is written as *"visible via `GET /reward-sub-categories`"*. `t127-migrations.e2e-spec.ts`
 *   proves the row exists by `SELECT`; that is the same predicate the service uses, so it cannot
 *   catch a row the endpoint filters out (a status filter, a scope clause, a DTO that drops the
 *   code). Only the endpoint can answer what the endpoint returns — and it is the endpoint the
 *   authoring screen's Kind/sub-category picker actually calls.
 * - **Verification steps 1 and 2** are about a `reward_policies.config` written by a real
 *   transaction, read back out of the real column — not about what a fake `update()` recorded.
 * - **"a curl gets the same answer as the SPA"** is the whole point of the bind-level gate. Step 5
 *   filters the picker, but `POST /campaigns/:id/rewards` is an ordinary endpoint; the only
 *   position the gate is worth anything from is a caller that never loaded the SPA, which is this
 *   file and not `RewardsStep.test.tsx`.
 *
 * ### Isolation
 *
 * Every fixture is prefixed `T127E2E` and every actor is named `T-127 …`, so `purgeSuiteResidue`
 * (T-132) can clear this suite's residue — and only this suite's — before and after the run. The
 * reward fixtures follow `campaigns.e2e-spec.ts`'s `ensure*` shape: created once, reused on later
 * runs, never counted globally.
 *
 * `afterAll` carries the one ordering constraint that is not obvious and that this suite got wrong
 * once (T-145): every teardown step that queries the app's own Sequelize must run **before**
 * `app.close()`. The reasoning is written out there, next to the code it governs.
 */
import { createServer, type Server } from 'node:http';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { ConfigService } from '@nestjs/config';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { SEQUELIZE } from '@/database/sequelize.provider';
import type { Env } from '@/config/env.schema';
import { PromoCodeServiceClient } from '@/modules/promo-code-integration/promo-code-service.client';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import type { PortalRole } from '@/database/portal-models';
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
import { loginCompletingMfa } from '../auth/support/super-admin-mfa';
import { createMigrationConnection } from '@/database/migration-connection';
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
} from './support/foreign-key-material';
import { purgeSuiteResidue } from './support/purge-suite-residue';

jest.setTimeout(600_000);

const SUITE = 't127';
const PASSWORD = 'correct horse battery staple 27!';
const PREFIX = 'T127E2E';
const COUNTRY_CODE = 'S7';
const USER_DISPLAY_PREFIX = 'T-127';

/** What the reward's author ticked: this reward may be attached at these two levels, not at
 * tracker level. The gate under test is exactly "is `level` in this list?". */
const ALLOWED_BIND_LEVELS = ['component', 'campaign'] as const;

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;
let borrowedKeyVars: string[] = [];

let adminUserId: number;
let countryId: number;
let tenantId: number;
let merchantId: number;
let activityId: number;
let promoPolicyId: number;
let cashPolicyId: number;

const createdCampaignIds = new Set<number>();

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
  try {
    await db.query(statement, { type: QueryTypes.RAW, replacements });
  } catch (error) {
    // A Sequelize error thrown inside `beforeAll` reaches Jest's reporter with an empty `message`
    // and no SQL — `purge-suite-residue.ts` documents the same trap. Naming the statement costs
    // nothing and is the difference between "11 failed" and a diagnosis.
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

async function makeActor(
  key: string,
  role: PortalRole,
  scope: { countryId: number | null; tenantId: number | null; merchantId: number | null },
): Promise<Actor> {
  const email = `t127-e2e-${key}@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `${USER_DISPLAY_PREFIX} ${key}`,
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
    userId,
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

// --- fixtures ------------------------------------------------------------------------------------

/** `assigned_by`/`created_by` on the `reward_config` side reference `admin_users`, not the portal's
 * own users — the same fixture attribution `campaigns.e2e-spec.ts` uses. */
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
     VALUES (:code, 'T-127 e2e country', 'Asia/Kuala_Lumpur', 'MYR', '+060', 'active') RETURNING id`,
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

async function ensureMerchant(): Promise<number> {
  const code = `${PREFIX}_M`;
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.merchants WHERE merchant_code = :code',
    { code },
  );
  if (existing !== undefined) return existing.id;
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.merchants (tenant_id, merchant_code, name, country_code, status)
     VALUES (:tenantId, :code, :code, :countryCode, 'active') RETURNING id`,
    { tenantId, code, countryCode: COUNTRY_CODE },
  );
  return created.id;
}

/** An activity this suite's merchant offers, so a component can be created through the API. */
async function ensureActivity(): Promise<number> {
  const [type] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.activity_types ORDER BY id LIMIT 1',
  );
  if (type === undefined) throw new Error('no activity_types rows — is the schema seeded?');

  const code = `${PREFIX}_ACT`;
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.activities WHERE tenant_id = :tenantId AND activity_code = :code',
    { tenantId, code },
  );
  const id =
    existing?.id ??
    (
      await sql<{ id: number }>(
        `INSERT INTO reward_config.activities (tenant_id, type_id, activity_code, name, status)
         VALUES (:tenantId, :typeId, :code, :code, 'active') RETURNING id`,
        { tenantId, typeId: type.id, code },
      )
    )[0].id;

  const [link] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.merchant_activities
      WHERE merchant_id = :merchantId AND activity_id = :activityId AND store_id IS NULL`,
    { merchantId, activityId: id },
  );
  if (link === undefined) {
    await exec(
      `INSERT INTO reward_config.merchant_activities (tenant_id, merchant_id, activity_id, status)
       VALUES (:tenantId, :merchantId, :activityId, 'active')`,
      { tenantId, merchantId, activityId: id },
    );
  }
  return id;
}

async function ensureRewardSystem(code: string, rewardType: string): Promise<number> {
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
         VALUES (NULL, :code, :code, :rewardType, 'internal', 'active') RETURNING id`,
        { code, rewardType },
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
 * A published, country-assigned version carrying the Kind — the row
 * `listRewardOptions`/`assertPromoCodeAttachable` read `reward_kind`/`value_config` off.
 * `value_config` is `text` holding JSON (`T119_001`), written here exactly as T-119's authoring
 * screen writes it.
 *
 * **The Kind is set in the `INSERT`, never by a later `UPDATE`, and a mismatched leftover gets a
 * new version rather than an edit.** `trg_reward_versions_immutable` (T005_007, extended by
 * T119_002 to cover exactly these two columns) refuses to change either on a row that is not
 * `draft`, and `trg_reward_versions_undeletable` refuses to remove it. That is the control this
 * task depends on — a published reward's Kind cannot drift — so the fixture works the way a real
 * author would: publish a new version and move the active country assignment onto it.
 */
async function ensureRewardVersion(
  rewardId: number,
  kind: string | null,
  valueConfig: unknown,
  unit: { type: string | null; code: string | null },
): Promise<number> {
  const serialized = valueConfig === null ? null : JSON.stringify(valueConfig);

  const [reusable] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.reward_versions
      WHERE reward_id = :rewardId
        AND reward_kind IS NOT DISTINCT FROM :kind
        AND value_config IS NOT DISTINCT FROM :valueConfig
      ORDER BY version_no DESC LIMIT 1`,
    { rewardId, kind, valueConfig: serialized },
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
       VALUES (:rewardId, :versionNo, :unitType, :unitCode, :kind, :valueConfig,
               'published', :adminUserId, :adminUserId, now())
       RETURNING id`,
      {
        rewardId,
        versionNo: next?.version_no ?? 1,
        unitType: unit.type,
        unitCode: unit.code,
        kind,
        valueConfig: serialized,
        adminUserId,
      },
    );
    versionId = created.id;
  }

  // Exactly one active assignment per reward, so `activeRewardVersionsByReward` cannot resolve an
  // older run's version instead of this one.
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
      `UPDATE reward_config.reward_version_country_assignments
          SET status = 'active' WHERE id = :id`,
      { id: assignment.id },
    );
  }
  return versionId;
}

async function ensureRewardPolicy(
  rewardId: number,
  code: string,
  config: Record<string, unknown>,
): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.reward_policies
      WHERE reward_system_id = :rewardId AND policy_code = :code`,
    { rewardId, code },
  );
  if (existing !== undefined) {
    // Reset the config, so one run's `promoCodeConfig` cannot make the next run's
    // "nothing picked" case pass for the wrong reason.
    await exec(`UPDATE reward_config.reward_policies SET config = :config WHERE id = :id`, {
      id: existing.id,
      config: JSON.stringify(config),
    });
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.reward_policies (reward_system_id, policy_code, name, config, status)
     VALUES (:rewardId, :code, :code, :config, 'active') RETURNING id`,
    { rewardId, code, config: JSON.stringify(config) },
  );
  return created.id;
}

/**
 * Puts a policy's `config` back to a known value.
 *
 * A `reward_policies` row is shared across every campaign it is attached to, so one case's pick
 * would otherwise still be sitting there when the next case reads the column — see this suite's
 * completion report for the product-level consequence of that same fact.
 */
async function resetPolicyConfig(policyId: number, config: Record<string, unknown>): Promise<void> {
  await exec(`UPDATE reward_config.reward_policies SET config = :config WHERE id = :id`, {
    id: policyId,
    config: JSON.stringify(config),
  });
}

/** The `config` column of a policy, read back out of Postgres as the runtime would see it. */
async function policyConfig(policyId: number): Promise<Record<string, unknown> | null> {
  const [row] = await sql<{ config: Record<string, unknown> | string | null }>(
    'SELECT config FROM reward_config.reward_policies WHERE id = :policyId',
    { policyId },
  );
  const raw = row?.config ?? null;
  if (raw === null) return null;
  return typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : raw;
}

/**
 * T-166 — how many `reward_assignment` audit rows this campaign has. Scoped to that entity type on
 * purpose: creating the draft writes its own `campaign` rows, so a bare count would never be zero
 * and the "nothing was written" assertions would prove nothing.
 */
async function auditRowCount(campaignId: number): Promise<number> {
  const [row] = await sql<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM reward_portal.portal_campaign_audit_trail
      WHERE campaign_id = :campaignId AND entity_type = 'reward_assignment'`,
    { campaignId },
  );
  return Number(row?.count ?? '0');
}

function inDays(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

let campaignSeq = 0;
async function createDraft(): Promise<number> {
  campaignSeq += 1;
  const response = await post('maker', '/campaigns', {
    campaignCode: `${PREFIX}_C${String(Date.now())}_${String(campaignSeq)}`,
    name: 'T-127 e2e campaign',
    startDate: inDays(1),
    endDate: inDays(30),
    budgetAmount: '100000.00',
    budgetCurrency: 'MYR',
  });
  if (response.status !== 201) {
    throw new Error(`createDraft failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  const id = response.body.data.id as number;
  createdCampaignIds.add(id);
  return id;
}

/** A campaign with one tracker, so a tracker-level attach is refused by the **Kind** gate rather
 * than by T-037's "that tracker is not in this campaign" gate. */
async function createDraftWithTracker(): Promise<{ id: number; trackerId: number }> {
  const id = await createDraft();
  await post('maker', `/campaigns/${String(id)}/merchants`, { merchantIds: [merchantId] }).expect(
    201,
  );
  const tracker = await post('maker', `/campaigns/${String(id)}/trackers`, {
    name: 'Onboarding',
    completionLogic: 'all',
  }).expect(201);
  return { id, trackerId: tracker.body.data.trackers[0].id as number };
}

// --- the promo-code-service stub (T-166) ---------------------------------------------------------

/**
 * A stand-in for promo-code-service, so this suite can attach a `PROMO_CODE` reward *with* a config
 * again — which since T-166 requires a successful `POST /api/v1/campaign-promo-configs` before any
 * local row is written.
 *
 * ### What is real here, and what is not
 *
 * A real HTTP server on a real port, called by a **real `PromoCodeServiceClient`** — real `fetch`,
 * real socket, real status codes, real error normalisation. The only substitution is the two
 * configuration values, injected through a stand-in `ConfigService` when the DI token is
 * overridden in `beforeAll`. That still exercises the wiring this file exists to check
 * (`BindingsService` really resolves and calls this token), and everything downstream of it.
 *
 * ### Why the values are overridden at the DI token and not through `process.env`
 *
 * They were, at first, and it silently did not work: `ConfigModule` passes `envFilePath` to
 * `@nestjs/config`, which loads `.env.development` **itself** (this process has no `.env.test`, and
 * `config.module.ts` resolves `.env.${NODE_ENV || 'development'}`), and `ConfigService.get` returns
 * a validated-env value in preference to `process.env`. So an assignment to `process.env` before
 * boot was overridden by the file's own `PROMO_CODE_SERVICE_BASE_URL=http://localhost:3010`, the
 * bind went to a port with nothing on it, and every promo attach 502'd. Recorded here because the
 * symptom — a correct-looking test failing with a real 502 — reads like a code defect and is not.
 *
 * `promoCodeStatus` lets a case make the stub refuse, which is how the two T-166 failure cases
 * below get a real 409/503 over a real socket.
 */
let promoCodeStub: Server;
let promoCodeBinds: Record<string, unknown>[] = [];
let promoCodeStatus = 201;
let promoCodeStubUrl: string;

const STUB_TOKEN = 'T127E2E-stub-service-token';

/** The real client, configured for the stub — what the DI token is overridden with. */
function stubPromoCodeServiceClient(): PromoCodeServiceClient {
  const config = {
    get: (key: string): unknown =>
      key === 'PROMO_CODE_SERVICE_BASE_URL' ? promoCodeStubUrl : STUB_TOKEN,
  };
  return new PromoCodeServiceClient(config as unknown as ConfigService<Env, true>);
}

async function startPromoCodeServiceStub(): Promise<void> {
  promoCodeStub = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      // The guard promo-code-service's own `InternalServiceTokenGuard` applies. Modelled here so
      // that a portal that stopped sending the header would fail this suite rather than pass it.
      if (req.headers.authorization !== `Bearer ${STUB_TOKEN}`) {
        res.writeHead(401);
        res.end();
        return;
      }
      promoCodeBinds.push(JSON.parse(body === '' ? '{}' : body) as Record<string, unknown>);
      res.writeHead(promoCodeStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'stub-binding-uuid', status: 'ACTIVE' }));
    });
  });
  await new Promise<void>((resolve) => promoCodeStub.listen(0, '127.0.0.1', resolve));
  const address = promoCodeStub.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  promoCodeStubUrl = `http://127.0.0.1:${String(port)}`;
}

async function stopPromoCodeServiceStub(): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    promoCodeStub.close((error) => (error ? reject(error) : resolve())),
  );
}

beforeEach(() => {
  promoCodeBinds = [];
  promoCodeStatus = 201;
});

// --- lifecycle -----------------------------------------------------------------------------------

beforeAll(async () => {
  // T-166 — the stub must be listening before the client that points at it is constructed.
  await startPromoCodeServiceStub();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // The real client, aimed at the stub instead of at `.env.development`'s localhost:3010 — see
    // `stubPromoCodeServiceClient` for why the two config values cannot be substituted through
    // `process.env` here.
    .overrideProvider(PromoCodeServiceClient)
    .useValue(stubPromoCodeServiceClient())
    .compile();
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

  await purgeSuiteResidue({ prefix: PREFIX, userDisplayNamePrefix: USER_DISPLAY_PREFIX });

  adminUserId = await ensureAdminUserId();
  countryId = await ensureCountry();
  tenantId = await ensureTenant();
  merchantId = await ensureMerchant();
  activityId = await ensureActivity();

  const promoReward = await ensureRewardSystem(`${PREFIX}_RWD_PROMO`, 'voucher');
  await ensureRewardVersion(
    promoReward,
    'PROMO_CODE',
    { apiProvider: 'PROMO_CODE_CONFIG_SERVICE', bindLevels: [...ALLOWED_BIND_LEVELS] },
    { type: null, code: null },
  );
  promoPolicyId = await ensureRewardPolicy(promoReward, `${PREFIX}_POL_PROMO`, {});

  const cashReward = await ensureRewardSystem(`${PREFIX}_RWD_CASH`, 'cashback');
  await ensureRewardVersion(
    cashReward,
    'FIXED_AMOUNT',
    { multiCurrency: false, defaultCurrency: 'MYR', defaultValue: 10 },
    { type: 'currency', code: 'MYR' },
  );
  cashPolicyId = await ensureRewardPolicy(cashReward, `${PREFIX}_POL_CASH`, { amount: '10.00' });

  await makeActor('maker', 'maker', { countryId, tenantId, merchantId: null });
  await makeActor('checker', 'checker', { countryId, tenantId, merchantId: null });
});

/**
 * T-145 regression guard. Asserts the invariant this whole e2e family depends on — *this suite
 * leaves no `encryption_keys` row behind* — from a connection that is deliberately **not** the
 * app's, because `db` is closed by the time this runs and could not answer.
 *
 * The twelve tests above all passed while the rows were still in the table, so nothing else in
 * this file could have caught the original defect; only a check of the real row, after the real
 * teardown, can. Residue is deleted as well as reported: leaving it would poison the next suite
 * exactly as the defect did, and a guard that hands the next reader a broken database to prove a
 * point is not a guard. The throw is what turns the suite red.
 */
async function assertNoEncryptionKeyResidue(): Promise<void> {
  const kids = keyIdsFor(SUITE);
  const admin = createMigrationConnection();
  try {
    const rows = await admin.query<{ kid: string }>(
      `SELECT kid FROM reward_portal.encryption_keys WHERE kid IN (:kids) ORDER BY kid`,
      { type: QueryTypes.SELECT, replacements: { kids: [kids.field, kids.blindIndex] } },
    );
    if (rows.length === 0) return;
    await admin.query(`DELETE FROM reward_portal.encryption_keys WHERE kid IN (:kids)`, {
      type: QueryTypes.DELETE,
      replacements: { kids: [kids.field, kids.blindIndex] },
    });
    throw new Error(
      `this suite's teardown left ${String(rows.length)} encryption_keys row(s) behind ` +
        `(${rows.map((row) => row.kid).join(', ')}). They have been deleted here so the next ` +
        `suite still boots, but that is damage control, not a pass: left in place they fail ` +
        `every test of the next suite that starts KeyRegistryService before its own sweep. The ` +
        `usual cause is a teardown step that queries the app's own Sequelize (\`db\`) having ` +
        `moved below \`app.close()\`, where it throws on a closed connection — see the comment ` +
        `in afterAll below.`,
    );
  } finally {
    await admin.close();
  }
}

afterAll(async () => {
  // Order matters here, and getting it wrong is the whole of T-145. `removeEncryptionKeys` queries
  // through `db` — the app's **own** injected Sequelize (`app.get<Sequelize>(SEQUELIZE)`) — and
  // `app.close()` tears that connection down through Nest's module-destroy lifecycle. Called
  // afterwards it throws ("ConnectionManager … was closed"), which the `.catch(() => undefined)`
  // that used to sit on it then swallowed: this suite stayed green at 12/12 while leaving
  // `t127_t056_fld`/`t127_t056_bidx` in `reward_portal.encryption_keys`, and the next suite to
  // boot `KeyRegistryService` failed on rows it never created. `field-value-source-lookup.e2e-spec.ts`
  // is the one that actually broke (all 17 tests), because it calls `app.init()` *before* its own
  // `ensureEncryptionKeys`, so `sweepOrphanedTestKeys` never gets the chance to clear them first —
  // and campaigns/ sorts before field-value-sources/ in plain alphabetical order.
  //
  // So: everything that touches `db` runs first, nothing moves below `app.close()`, and the
  // failure stays unswallowed. Same ordering and same reasoning as
  // `test/wave6/rules-rewards-value-sources.e2e-spec.ts`'s `afterAll`, which documents it too.
  // `purgeSuiteResidue` opens its own migration connection and is ordering-independent, but is
  // kept above the close for the same reason — no teardown reader should have to work out which
  // of these lines is which.
  await purgeSuiteResidue({ prefix: PREFIX, userDisplayNamePrefix: USER_DISPLAY_PREFIX });
  if (db !== undefined) await removeEncryptionKeys(db, SUITE);
  if (app !== undefined) await app.close();
  clearProvidedKeyMaterial(borrowedKeyVars);
  // T-166 — below `app.close()` deliberately: nothing here touches `db`, and the port must stay
  // open until the app that might still be talking to it is gone.
  if (promoCodeStub !== undefined) await stopPromoCodeServiceStub();

  await assertNoEncryptionKeyResidue();
});

// --- TC-5 ----------------------------------------------------------------------------------------

describe('T-127 · TC-5: the VOUCHER/PROMO_CODE sub-category is visible where the product looks', () => {
  it('GET /reward-sub-categories lists PROMO_CODE under VOUCHER', async () => {
    const categories = await get('maker', '/reward-categories').expect(200);
    const voucher = (categories.body.data as { id: number; categoryCode: string }[]).find(
      (row) => row.categoryCode === 'VOUCHER',
    );
    expect(voucher).toBeDefined();

    const response = await get(
      'maker',
      `/reward-sub-categories?categoryId=${String(voucher?.id ?? 0)}`,
    ).expect(200);

    const promoCode = (
      response.body.data as { subCategoryCode: string; name: string; status: string }[]
    ).find((row) => row.subCategoryCode === 'PROMO_CODE');
    expect(promoCode).toBeDefined();
    expect(promoCode?.name).toBe('Promo Code');
    expect(promoCode?.status).toBe('active');
  });

  it('and is reachable in the unfiltered list too, which is what the authoring screen loads', async () => {
    const response = await get('maker', '/reward-sub-categories').expect(200);
    expect(
      (response.body.data as { subCategoryCode: string }[]).some(
        (row) => row.subCategoryCode === 'PROMO_CODE',
      ),
    ).toBe(true);
  });
});

// --- what step 5 is given ------------------------------------------------------------------------

describe('T-127 · GET /campaigns/:id/reward-options over HTTP', () => {
  it('carries rewardKind and promoCodeBindLevels for the PROMO_CODE reward', async () => {
    const id = await createDraft();

    const response = await get('maker', `/campaigns/${String(id)}/reward-options`).expect(200);
    const options = response.body.data as {
      rewardPolicyId: number;
      rewardKind: string | null;
      promoCodeBindLevels: string[] | null;
    }[];

    const promo = options.find((option) => option.rewardPolicyId === promoPolicyId);
    expect(promo?.rewardKind).toBe('PROMO_CODE');
    expect(promo?.promoCodeBindLevels).toEqual([...ALLOWED_BIND_LEVELS]);
  });

  it('TC-6: reports nothing promo-shaped for a reward of another Kind', async () => {
    const id = await createDraft();

    const response = await get('maker', `/campaigns/${String(id)}/reward-options`).expect(200);
    const cash = (
      response.body.data as {
        rewardPolicyId: number;
        rewardKind: string | null;
        promoCodeBindLevels: string[] | null;
      }[]
    ).find((option) => option.rewardPolicyId === cashPolicyId);

    expect(cash?.rewardKind).toBe('FIXED_AMOUNT');
    expect(cash?.promoCodeBindLevels).toBeNull();
  });
});

// --- verification steps 1 and 2 ------------------------------------------------------------------

describe('T-127 · attaching a PROMO_CODE reward to a real campaign', () => {
  it('Verification 1 + 2: attaches with nothing picked, and leaves the stored config structurally sound', async () => {
    await resetPolicyConfig(promoPolicyId, {});
    const id = await createDraft();

    await post('maker', `/campaigns/${String(id)}/rewards`, {
      level: 'campaign',
      rewardPolicyId: promoPolicyId,
    }).expect(201);

    // The attachment is really there…
    const [assignment] = await sql<{ id: number }>(
      `SELECT id FROM reward_config.reward_campaign_assignments
        WHERE campaign_id = :id AND reward_policy_id = :policyId`,
      { id, policyId: promoPolicyId },
    );
    expect(assignment).toBeDefined();

    // …and the config the picker had nothing to write into is `{}`, not `{"promoCodeConfig":null}`
    // — no later reader has to special-case a key that means "not picked".
    expect(await policyConfig(promoPolicyId)).toEqual({});
  });

  it('writes the maker’s pick into reward_policies.config, merged with what was already there', async () => {
    const id = await createDraft();
    await resetPolicyConfig(promoPolicyId, { notes: 'author supplied' });

    await post('maker', `/campaigns/${String(id)}/rewards`, {
      level: 'campaign',
      rewardPolicyId: promoPolicyId,
      promoCodeConfig: 'RAYA_2026',
    }).expect(201);

    expect(await policyConfig(promoPolicyId)).toEqual({
      notes: 'author supplied',
      promoCodeConfig: 'RAYA_2026',
    });

    // T-166 — and the binding really left this process, over a real socket, with §2's body built
    // from the campaign and the verified maker. T-170: `tenantId`/`bindRefId`/`boundBy` are the
    // portal's own ids as plain decimal **strings** — promo-code-service stores them verbatim in
    // `varchar` columns (T-PC-052), so what a real server parsed off the wire here is exactly what
    // it would persist. Asserted post-`JSON.parse`, which is where a number/string mix-up shows.
    expect(promoCodeBinds).toEqual([
      {
        promoCodeConfigId: 'RAYA_2026',
        tenantId: String(tenantId),
        bindLevel: 'CAMPAIGN',
        bindRefId: String(id),
        boundBy: expect.stringMatching(/^\d+$/) as unknown as string,
      },
    ]);
  });

  it('TC-4: attaches at component level too — the same reward, no level-specific special-casing', async () => {
    // The unit suite proves the gate accepts `component`; what only this file can show is that a
    // real component-level attach lands, through the same endpoint, for the same reward that was
    // just refused at tracker level.
    const { id, trackerId } = await createDraftWithTracker();

    const withComponent = await post(
      'maker',
      `/campaigns/${String(id)}/trackers/${String(trackerId)}/components`,
      { name: 'First purchase', activityId },
    ).expect(201);
    const componentId = withComponent.body.data.trackers[0].components[0].id as number;

    await post('maker', `/campaigns/${String(id)}/rewards`, {
      level: 'component',
      refId: componentId,
      rewardPolicyId: promoPolicyId,
    }).expect(201);
  });
});

// --- T-166: verification step 3, against a real (stub) service ------------------------------------

/**
 * T-166's verification steps 2 and 3 ask for a live promo-code-service and a stopped one. That
 * service cannot currently be started in this environment (its own T-PC-049 is unlanded — see the
 * T-165 and T-166 completion reports), so these two cases stand in for those steps at the level
 * that actually matters: a **real** HTTP round trip whose failure must leave the portal's own
 * database untouched. Everything below `POST /campaigns/:id/rewards` here is production code —
 * only the far end of the socket is a stub.
 */
describe('T-166 · a refused bind leaves nothing behind, end to end', () => {
  it('a 409 from promo-code-service fails the attach and writes no assignment', async () => {
    await resetPolicyConfig(promoPolicyId, {});
    const id = await createDraft();
    promoCodeStatus = 409;

    const response = await post('maker', `/campaigns/${String(id)}/rewards`, {
      level: 'campaign',
      rewardPolicyId: promoPolicyId,
      promoCodeConfig: 'ARCHIVED_CONFIG',
    }).expect(409);

    expect(response.body.error.code).toBe('PROMO_CODE_CONFIG_NOT_BINDABLE');

    // The three things a successful attach would have written, all absent.
    const rows = await sql<{ id: number }>(
      `SELECT id FROM reward_config.reward_campaign_assignments
        WHERE campaign_id = :id AND reward_policy_id = :policyId`,
      { id, policyId: promoPolicyId },
    );
    expect(rows).toHaveLength(0);
    expect(await policyConfig(promoPolicyId)).toEqual({});
    expect(await auditRowCount(id)).toBe(0);
  });

  it('verification step 3: an upstream failure is a 502, and still writes nothing', async () => {
    await resetPolicyConfig(promoPolicyId, {});
    const id = await createDraft();
    promoCodeStatus = 503;

    const response = await post('maker', `/campaigns/${String(id)}/rewards`, {
      level: 'campaign',
      rewardPolicyId: promoPolicyId,
      promoCodeConfig: 'RAYA_2026',
    }).expect(502);

    expect(response.body.error.code).toBe('PROMO_CODE_SERVICE_BIND_FAILED');

    const rows = await sql<{ id: number }>(
      `SELECT id FROM reward_config.reward_campaign_assignments
        WHERE campaign_id = :id AND reward_policy_id = :policyId`,
      { id, policyId: promoPolicyId },
    );
    expect(rows).toHaveLength(0);
    expect(await policyConfig(promoPolicyId)).toEqual({});
    expect(await auditRowCount(id)).toBe(0);
  });

  it('an attach with no config picked never reaches promo-code-service at all', async () => {
    await resetPolicyConfig(promoPolicyId, {});
    const id = await createDraft();

    await post('maker', `/campaigns/${String(id)}/rewards`, {
      level: 'campaign',
      rewardPolicyId: promoPolicyId,
    }).expect(201);

    expect(promoCodeBinds).toEqual([]);
  });
});

// --- the gate, from a caller that never loaded the SPA --------------------------------------------

describe('T-127 · the bind-level gate is a server control, not a picker filter', () => {
  it('refuses a tracker-level attach the author excluded, with 400 REWARD_NOT_ATTACHABLE_AT_LEVEL', async () => {
    const { id, trackerId } = await createDraftWithTracker();

    const response = await post('maker', `/campaigns/${String(id)}/rewards`, {
      level: 'tracker',
      refId: trackerId,
      rewardPolicyId: promoPolicyId,
    }).expect(400);

    expect(response.body.error.code).toBe('REWARD_NOT_ATTACHABLE_AT_LEVEL');

    // Nothing was written: the gate runs before the insert.
    const rows = await sql<{ id: number }>(
      'SELECT id FROM reward_config.reward_tracker_assignments WHERE tracker_id = :trackerId',
      { trackerId },
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses a promoCodeConfig sent for a reward that is not PROMO_CODE', async () => {
    const id = await createDraft();

    const response = await post('maker', `/campaigns/${String(id)}/rewards`, {
      level: 'campaign',
      rewardPolicyId: cashPolicyId,
      promoCodeConfig: 'RAYA_2026',
    }).expect(400);

    expect(response.body.error.code).toBe('PROMO_CODE_CONFIG_NOT_APPLICABLE');
    // The unrelated reward's own config is untouched by the refused call.
    expect(await policyConfig(cashPolicyId)).toEqual({ amount: '10.00' });
  });

  it('TC-6: an ordinary reward still attaches with no promo handling anywhere near it', async () => {
    const id = await createDraft();

    await post('maker', `/campaigns/${String(id)}/rewards`, {
      level: 'campaign',
      rewardPolicyId: cashPolicyId,
    }).expect(201);

    expect(await policyConfig(cashPolicyId)).toEqual({ amount: '10.00' });
  });

  it('refuses an explicit null config — "nothing picked" is an absent key, not a null', async () => {
    const id = await createDraft();

    // The DTO's `@IsOptional()` lets a `null` past the property decorators; the shared contract
    // does not. Which layer refuses it is an implementation detail — that the request is refused,
    // and no `promoCodeConfig: null` is ever stored, is the property (see `dto.spec.ts`).
    await post('maker', `/campaigns/${String(id)}/rewards`, {
      level: 'campaign',
      rewardPolicyId: promoPolicyId,
      promoCodeConfig: null,
    }).expect(400);
  });

  it('R6: a checker cannot attach a promo code reward at all', async () => {
    await resetPolicyConfig(promoPolicyId, {});
    const id = await createDraft();

    await post('checker', `/campaigns/${String(id)}/rewards`, {
      level: 'campaign',
      rewardPolicyId: promoPolicyId,
      promoCodeConfig: 'RAYA_2026',
    }).expect(403);

    expect(await policyConfig(promoPolicyId)).not.toHaveProperty('promoCodeConfig');
  });
});
