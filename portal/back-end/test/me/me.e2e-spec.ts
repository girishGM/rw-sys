/**
 * T-015 — `/me` against the **real** Postgres instance, through the real `AppModule`, over real
 * HTTP, as all six roles.
 *
 * ### Why this suite is the one that matters for this task
 *
 * T-015's Definition of Done says it plainly: *"**All six roles verified by hand** — a bootstrap
 * that is correct for one role and wrong for another is the most expensive bug to find later."*
 * The unit suites in this directory prove the *decisions* (which query, which tree, which status);
 * none of them can prove the thing the SPA actually depends on, which is that the seeded
 * configuration in 01-DATABASE.md §5.2/§5.3 comes back, per role, in the right order, through the
 * whole §6 security chain.
 *
 * So the nav and widget assertions below are made against **the seed migrations themselves**
 * (`T004_002`, `T004_003`, and every later migration listed in `NAV_SEED_MIGRATIONS`), not against
 * numbers copied into this file. That is deliberate: a hand-copied count is a second source of
 * truth that drifts, and it is exactly how the task file's own TC-1/TC-2 counts (7 and 5) came to
 * disagree with the design doc (8 and 6, after AR-09 added `grpc_grants` and 11-BUDGETS added
 * `budget_ceilings`). Asserting against the seed makes the test say *"the endpoint returns what was
 * seeded"*, which is the property, and makes a future seed change a one-place edit.
 *
 * **T-069 finished that job.** The principle above was stated from the start but only half applied:
 * `seededNavKeys` read `T004_002` alone, while six counts and three ordered menus were written out
 * as literals after all. When `T042_002` (`definition_requests`) and `T049_001`
 * (`campaign_assistant`) later seeded more rows, eleven tests failed against an endpoint that was
 * behaving correctly. The literals are gone and the seed list is now plural and guarded by its own
 * test; see `NAV_SEED_MIGRATIONS`.
 *
 * ### Fixtures, and what cannot be cleaned up
 *
 * The same constraints `rbac.e2e-spec.ts` documents. `reward_app` has `DELETE` on **nothing** in
 * `reward_config` (01-DATABASE.md §3), so:
 *
 *  - the fixture country/tenant/merchant persist between runs and are re-used idempotently; they
 *    are set `inactive` at the end and are inert.
 *  - `portal_users` and everything cascading from them *are* deleted — `reward_portal` allows it.
 *  - **every mutation of a seeded configuration row is made inside `try/finally` and restored to
 *    its exact prior value.** `role_nav_configs`, `role_dashboard_widgets` and `rbac_cache_config`
 *    are global seed state that T-004's own e2e asserts on, and a suite that left a nav row
 *    disabled would break an already-`done` task's tests a little more on every run. T-013's
 *    completion report records that exact mistake being made once; this suite treats restoration
 *    as part of the assertion rather than as cleanup.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import request from 'supertest';
import {
  BOOTSTRAP_CACHE_CONTROL as SHARED_CACHE_CONTROL,
  bootstrapEnvelopeSchema,
  meProfileEnvelopeSchema,
} from '@reward-portal/shared';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import { ROLE_NAV_CONFIGS } from '@/database/migrations/T004_002_seed_role_nav_configs';
import { ROLE_DASHBOARD_WIDGETS } from '@/database/migrations/T004_003_seed_role_dashboard_widgets';
// T-069 — `role_nav_configs` is seeded by more than one migration. See NAV_SEED_MIGRATIONS below.
import { DEFINITION_REQUEST_NAV_CONFIGS } from '@/database/migrations/T042_002_seed_definition_request_nav';
import { AGENT_NAV_CONFIGS } from '@/database/migrations/T049_001_seed_agent_nav';
import { RULE_CATEGORY_NAV_CONFIGS } from '@/database/migrations/T107_001_seed_rule_category_nav';
import { REWARD_CATEGORY_NAV_CONFIGS } from '@/database/migrations/T117_001_seed_reward_category_nav';
import { RULE_VALUE_SOURCES_NAV_CONFIGS } from '@/database/migrations/T146_001_seed_rule_value_sources_nav';
import { NEW_NAV_ROWS as RULES_REWARDS_NAV_CONFIGS } from '@/database/migrations/T157_001_nest_rules_rewards_nav';
import type { PortalRole } from '@/database/portal-models';
import { expectErrorEnvelope } from '../common/support/error-envelope';
// T-055 — a `super_admin` login now ends in an MFA challenge; this completes it through the real
// endpoints. See the helper's own header for why it is not a session-minting shortcut.
import { loginCompletingMfa } from '../auth/support/super-admin-mfa';
// T-056 — `portal_users.email` is encrypted, so fixtures are inserted through the application's own
// crypto and both key purposes have to be provisioned before boot.
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import { expectBootstrapDisclosure, expectNoSecretMaterial } from './support/secret-scan';

/** Namespaces this suite's `encryption_keys` row, so two suites cannot delete each other's. */
const MFA_SUITE = 't015';

jest.setTimeout(300_000);

const PASSWORD = 'correct horse battery staple 7!';
/** `countries.code` is `character(2)`. */
const COUNTRY_CODE = 'YZ';
const TENANT_CODE = 'T015_E2E_T';
const MERCHANT_CODE = 'T015_E2E_M';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

let countryId: number;
let tenantId: number;
let merchantId: number;

interface Actor {
  readonly key: string;
  readonly email: string;
  readonly userId: number;
  readonly role: PortalRole;
  readonly jar: string;
  readonly csrf: string;
}

const actors = new Map<string, Actor>();

// --- harness -----------------------------------------------------------------------------------

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

async function makeActor(
  key: string,
  role: PortalRole,
  scope: { countryId: number | null; tenantId: number | null; merchantId: number | null },
  options: { mustChangePassword?: boolean } = {},
): Promise<Actor> {
  const email = `t015-e2e-${key}@example.invalid`;

  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const created = {
    id: await insertPortalUser(db, emailCrypto, {
      email,
      displayName: `T-015 ${key}`,
      role,
      ...scope,
      mustChangePassword: options.mustChangePassword ?? false,
      preferredTimezone: 'Asia/Kolkata',
    }),
  };

  await exec(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    { userId: created.id, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
  );

  // T-055 made a second factor structurally mandatory for `super_admin`, so a login by that role
  // now ends in an MFA challenge rather than in a session (02-SECURITY.md §2a). `loginCompletingMfa`
  // completes the challenge through the real endpoints — nothing stubbed, no guard bypassed — and
  // is a plain login for the other five roles, which are unaffected.
  const response = await loginCompletingMfa(app, { email, password: PASSWORD }, db);
  if (response.status !== 200) {
    throw new Error(`login for ${key} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  const actor: Actor = {
    key,
    email,
    userId: created.id,
    role,
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

function patch(key: string, path: string, body: unknown) {
  return http()
    .patch(`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf)
    .send(body as object);
}

/** `GET /me/bootstrap` as `key`, asserted 200 and schema-valid, returning the payload. */
async function bootstrapOf(key: string) {
  const response = await get(key, '/me/bootstrap');
  expect(response.status).toBe(200);

  const parsed = bootstrapEnvelopeSchema.safeParse(response.body);
  // Reported as the issue list, so a failure names the field rather than saying "false".
  expect(parsed.success ? null : parsed.error.issues).toBeNull();

  return { response, body: response.body.data as ReturnType<typeof expectBootstrapShape> };
}

/** Present only for the return type above; never called. */
function expectBootstrapShape() {
  return bootstrapEnvelopeSchema.parse({
    data: {
      user: { id: 0, displayName: '', role: 'maker', locale: 'en', timezone: null },
      scope: { countryId: null, tenantId: null, merchantId: null },
      nav: [],
      permissions: {},
      widgets: [],
      messages: {},
    },
  }).data;
}

/** The shape every `role_nav_configs` seed migration exports. `parentNavKey` is optional because
 * only `T157_001` (and, after `NAV_PARENT_OVERRIDES` below, three rows `T107_001`/`T117_001`/
 * `T146_001` originally seeded flat) ever populate it — every earlier migration's own row shape
 * simply omits the field, which is structurally `undefined`, normalised to `null` by
 * `effectiveParent` below. */
interface SeededNavRow {
  role: string;
  navKey: string;
  label: string;
  path: string;
  sortOrder: number;
  parentNavKey?: string | null;
}

/** `row.parentNavKey`, with `undefined` (every pre-T157 migration's row shape) normalised to
 * `null` — the two are the same "no parent, this is a root" state, just spelled differently
 * depending on whether the exporting migration ever declared the field at all. */
function effectiveParent(row: SeededNavRow): string | null {
  return row.parentNavKey ?? null;
}

/**
 * **Every** migration that seeds `reward_config.role_nav_configs`, paired with the constant it
 * exports (T-069).
 *
 * `T004_002` was the only one when this suite was written, so `seededNavKeys` read it alone and the
 * expectations silently went stale the moment `T042_002` and `T049_001` each added rows — 11 tests
 * failed against a *correct* endpoint. The file header already committed to asserting "against the
 * seed migrations themselves, not against numbers copied into this file"; the bug was that it read
 * one seed migration and there were three.
 *
 * Adding a nav row to a new migration therefore means adding one line here. The
 * `covers every migration that seeds role_nav_configs` test below fails if you forget, which is the
 * point — the previous arrangement had no way to notice.
 */
const NAV_SEED_MIGRATIONS: { readonly file: string; readonly rows: readonly SeededNavRow[] }[] = [
  { file: 'T004_002_seed_role_nav_configs.ts', rows: ROLE_NAV_CONFIGS },
  { file: 'T042_002_seed_definition_request_nav.ts', rows: DEFINITION_REQUEST_NAV_CONFIGS },
  { file: 'T049_001_seed_agent_nav.ts', rows: AGENT_NAV_CONFIGS },
  { file: 'T107_001_seed_rule_category_nav.ts', rows: RULE_CATEGORY_NAV_CONFIGS },
  { file: 'T117_001_seed_reward_category_nav.ts', rows: REWARD_CATEGORY_NAV_CONFIGS },
  { file: 'T146_001_seed_rule_value_sources_nav.ts', rows: RULE_VALUE_SOURCES_NAV_CONFIGS },
  // T-157 — only its two *inserted* rows (`rules_all`/`rewards_all`, already carrying their own
  // `parentNavKey`) belong in this INSERT-only registry; its other half (re-parenting three rows
  // the migrations above already registered) is `NAV_PARENT_OVERRIDES`' job, the same INSERT/
  // UPDATE split `t004-seeds-bootstrap.e2e-spec.ts`'s own `PERMISSION_SEED_EXTRAS`/
  // `PERMISSION_UPDATE_MIGRATIONS` make for `role_entity_permissions`.
  { file: 'T157_001_nest_rules_rewards_nav.ts', rows: RULES_REWARDS_NAV_CONFIGS },
];

/**
 * `(role, navKey)` pairs an already-registered migration seeded with no parent, later re-parented
 * *in place* by `T157_001` (`RENESTED_ROWS`, that migration's own second half). Applied as an
 * override rather than edited into `T107_001`/`T117_001`/`T146_001`'s own exported constants
 * (files this task does not own, R9) — the same reason `t004-seeds-bootstrap.e2e-spec.ts`'s
 * `PERMISSION_UPDATE_MIGRATIONS`/`applyPermissionUpdateOverrides` exist for
 * `role_entity_permissions`.
 */
const NAV_PARENT_OVERRIDES: {
  readonly role: string;
  readonly navKey: string;
  readonly parentNavKey: string;
}[] = [
  { role: 'super_admin', navKey: 'rule_categories', parentNavKey: 'rules' },
  { role: 'super_admin', navKey: 'rule_value_sources', parentNavKey: 'rules' },
  { role: 'super_admin', navKey: 'reward_categories', parentNavKey: 'rewards' },
];

function withNavParentOverrides(rows: readonly SeededNavRow[]): SeededNavRow[] {
  return rows.map((row) => {
    const override = NAV_PARENT_OVERRIDES.find(
      (candidate) => candidate.role === row.role && candidate.navKey === row.navKey,
    );
    return override === undefined ? row : { ...row, parentNavKey: override.parentNavKey };
  });
}

/** Every seeded nav row, from every seeding migration, flattened, with `NAV_PARENT_OVERRIDES`
 * applied — this is the post-`T157_001` shape the live table actually has. */
const SEEDED_NAV_ROWS: readonly SeededNavRow[] = withNavParentOverrides(
  NAV_SEED_MIGRATIONS.flatMap((migration) => migration.rows),
);

/**
 * The **root-level** nav keys the seed migrations give `role`, in the order the endpoint returns
 * them at the top of `body.nav` — i.e. every seeded row for `role` whose `parentNavKey` is `null`
 * (every row, for every role except `super_admin` as of T-157; see `seededNavChildren` for the
 * nested half).
 *
 * The comparator mirrors `bootstrap.service.ts`'s `order: [['sortOrder','ASC'], ['navKey','ASC']]`
 * exactly, tiebreaker included. The previous version sorted on `sortOrder` alone, which only
 * happened to agree because no role had two rows sharing one — `definition_requests` (45) landing
 * between `rewards` (40) and `users` (50) is the kind of interleave that makes the order real
 * rather than incidental.
 */
function seededNavKeys(role: string, rows: readonly SeededNavRow[] = SEEDED_NAV_ROWS): string[] {
  return rows
    .filter((row) => row.role === role && effectiveParent(row) === null)
    .slice()
    .sort((left, right) =>
      left.sortOrder !== right.sortOrder
        ? left.sortOrder - right.sortOrder
        : left.navKey.localeCompare(right.navKey),
    )
    .map((row) => row.navKey);
}

/** The nav keys the seed migrations nest under `parentNavKey` for `role`, in the same order
 * `body.nav`'s matching node's own `children` array returns them (T-157: `super_admin`'s `rules`/
 * `rewards` groups are the first real case; every other role's parent has no children today, so
 * this returns `[]` for them, matching the flat behaviour this suite already asserted). */
function seededNavChildren(
  role: string,
  parentNavKey: string,
  rows: readonly SeededNavRow[] = SEEDED_NAV_ROWS,
): string[] {
  return rows
    .filter((row) => row.role === role && effectiveParent(row) === parentNavKey)
    .slice()
    .sort((left, right) =>
      left.sortOrder !== right.sortOrder
        ? left.sortOrder - right.sortOrder
        : left.navKey.localeCompare(right.navKey),
    )
    .map((row) => row.navKey);
}

/** The widget keys 01-DATABASE.md §5.3 seeds for `role`, in `sort_order`. */
function seededWidgetKeys(role: string): string[] {
  return ROLE_DASHBOARD_WIDGETS.filter((row) => row.role === role)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((row) => row.widgetKey);
}

// --- idempotent reward_config fixtures ---------------------------------------------------------

async function ensureCountry(): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.countries WHERE code = :code`,
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
     VALUES (:code, 'T-015 e2e country', 'UTC', 'USD', '+001', 'active')
     RETURNING id`,
    { code: COUNTRY_CODE },
  );
  return created.id;
}

async function ensureTenant(): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.tenants WHERE code = :code`,
    { code: TENANT_CODE },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.tenants
          SET status = 'active', deleted_at = NULL, country_id = :countryId
        WHERE id = :id`,
      { id: existing.id, countryId },
    );
    return existing.id;
  }

  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES (:code, :code, :countryId, 'active')
     RETURNING id`,
    { code: TENANT_CODE, countryId },
  );
  return created.id;
}

async function ensureMerchant(): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.merchants WHERE merchant_code = :code`,
    { code: MERCHANT_CODE },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.merchants
          SET status = 'active', deleted_at = NULL, tenant_id = :tenantId
        WHERE id = :id`,
      { id: existing.id, tenantId },
    );
    return existing.id;
  }

  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.merchants (tenant_id, merchant_code, name, country_code, status)
     VALUES (:tenantId, :code, :code, :countryCode, 'active')
     RETURNING id`,
    { code: MERCHANT_CODE, tenantId, countryCode: COUNTRY_CODE },
  );
  return created.id;
}

// --- restorable mutations of seeded configuration ----------------------------------------------
// Every one of these reads the current value, hands it to the caller and is undone in a `finally`.
// See the file header for why that is not optional here.

async function withNavRow<T>(
  role: string,
  navKey: string,
  mutate: string,
  replacements: Record<string, unknown>,
  body: () => Promise<T>,
): Promise<T> {
  const [before] = await sql<{
    enabled: boolean;
    parent_nav_key: string | null;
    sort_order: number;
  }>(
    `SELECT enabled, parent_nav_key, sort_order FROM reward_config.role_nav_configs
      WHERE role = :role AND nav_key = :navKey`,
    { role, navKey },
  );
  if (before === undefined) throw new Error(`no seeded nav row ${role}/${navKey}`);

  try {
    await exec(mutate, { role, navKey, ...replacements });
    return await body();
  } finally {
    await exec(
      `UPDATE reward_config.role_nav_configs
          SET enabled = :enabled, parent_nav_key = :parentNavKey, sort_order = :sortOrder,
              updated_at = now()
        WHERE role = :role AND nav_key = :navKey`,
      {
        role,
        navKey,
        enabled: before.enabled,
        parentNavKey: before.parent_nav_key,
        sortOrder: before.sort_order,
      },
    );
  }
}

async function withRbacVersionBump<T>(role: string, body: () => Promise<T>): Promise<T> {
  const [before] = await sql<{ config_value: string }>(
    `SELECT config_value FROM reward_config.rbac_cache_config WHERE config_key = :key`,
    { key: `rbac_version:${role}` },
  );

  try {
    await exec(
      `UPDATE reward_config.rbac_cache_config
          SET config_value = (config_value::bigint + 1)::text, updated_at = now()
        WHERE config_key = :key`,
      { key: `rbac_version:${role}` },
    );
    return await body();
  } finally {
    // Restored to the exact prior value — 1 → 2 → 1 invalidates twice, which is what the test
    // wants, and leaves the row as T004_005 wrote it (T-013's precedent).
    await exec(
      `UPDATE reward_config.rbac_cache_config
          SET config_value = :value, updated_at = now()
        WHERE config_key = :key`,
      { key: `rbac_version:${role}`, value: before.config_value },
    );
  }
}

// --- lifecycle ---------------------------------------------------------------------------------

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  // T-055: `super_admin` enrolment writes an encrypted `mfa_secret_enc`, which needs an active
  // `field` key. T-056 added a second requirement — `portal_users.email` is encrypted too, so a
  // login also needs an active `blind_index` key to compute the lookup index. `ensureEncryptionKeys`
  // provisions both. Inserted **before** `app.init()`/`listen()` because `KeyRegistryService` reads
  // `encryption_keys` once, at boot. Removed again in `afterAll`.
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), MFA_SUITE);

  app = moduleRef.createNestApplication();
  // Identical to main.ts — the pipe and its exception factory are part of the contract under test
  // (TC-16/TC-17 assert `forbidNonWhitelisted`'s 400).
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

  countryId = await ensureCountry();
  tenantId = await ensureTenant();
  merchantId = await ensureMerchant();

  await makeActor('super', 'super_admin', {
    countryId: null,
    tenantId: null,
    merchantId: null,
  });
  await makeActor('country', 'country_admin', { countryId, tenantId: null, merchantId: null });
  await makeActor('tenant', 'tenant_admin', { countryId, tenantId, merchantId: null });
  await makeActor('maker', 'maker', { countryId, tenantId, merchantId: null });
  await makeActor('checker', 'checker', { countryId, tenantId, merchantId: null });
  await makeActor('merchant', 'merchant', { countryId, tenantId, merchantId });
  await makeActor(
    'confined',
    'maker',
    { countryId, tenantId, merchantId: null },
    { mustChangePassword: true },
  );
});

afterAll(async () => {
  if (db !== undefined) {
    // T-056: `email` is ciphertext, so `LIKE 't015-e2e-%'` on it matches nothing. `display_name` is
    // not encrypted and every actor above sets it to `T-015 <key>`, so it is the reliable handle for
    // a prefix-style cleanup — and unlike a list of addresses it also catches an actor added later.
    await exec(`DELETE FROM reward_portal.portal_users WHERE display_name LIKE 'T-015 %'`);

    // Defensive: every mutation above restores itself in a `finally`, and this asserts nothing —
    // it exists so that a suite killed mid-run cannot leave the shared seed disabled.
    await exec(
      `UPDATE reward_config.role_nav_configs SET enabled = true, parent_nav_key = NULL
        WHERE role IN ('maker','merchant') AND enabled = false`,
    );

    await exec(
      `UPDATE reward_config.merchants SET status = 'inactive' WHERE merchant_code = :code`,
      { code: MERCHANT_CODE },
    );
    await exec(
      `UPDATE reward_config.tenants SET status = 'inactive', deleted_at = now() WHERE code = :code`,
      { code: TENANT_CODE },
    );
    await exec(`UPDATE reward_config.countries SET status = 'inactive' WHERE code = :code`, {
      code: COUNTRY_CODE,
    });

    // T-055's fixture key. Removed here so nothing about the real key configuration is left
    // changed for longer than this file runs.
    await removeEncryptionKeys(db, MFA_SUITE);
  }
  if (app !== undefined) await app.close();
});

// --- TC-1 … TC-6 — the six roles ---------------------------------------------------------------

describe('TC-1…TC-6 — one correct payload per role', () => {
  const roleOf: Record<string, PortalRole> = {
    super: 'super_admin',
    country: 'country_admin',
    tenant: 'tenant_admin',
    maker: 'maker',
    checker: 'checker',
    merchant: 'merchant',
  };

  it.each(Object.entries(roleOf))(
    '%s: nav is exactly the seeded menu for its role, in sort_order',
    async (key, role) => {
      const { body } = await bootstrapOf(key);

      // Root level first: every role but `super_admin` still has no parented rows at all (T-157
      // nests `super_admin`'s own "Rules"/"Rewards"), so `seededNavChildren` naturally returns
      // `[]` for the rest and this loop covers the pre-T157 "flat menu, no children" case too.
      expect(body.nav.map((item) => item.key)).toEqual(seededNavKeys(role));
      for (const item of body.nav) {
        expect(item.children.map((child) => child.key)).toEqual(seededNavChildren(role, item.key));
      }
    },
  );

  it.each(Object.entries(roleOf))(
    'TC-9 — %s: widgets are exactly the seeded dashboard for its role, in sort_order',
    async (key, role) => {
      const { body } = await bootstrapOf(key);

      expect(body.widgets.map((widget) => widget.key)).toEqual(seededWidgetKeys(role));
      expect(body.widgets.every((widget) => typeof widget.config === 'object')).toBe(true);
    },
  );

  it('TC-1: super_admin has access_control, and the role/scope block is all-null', async () => {
    const { body } = await bootstrapOf('super');

    expect(body.nav.map((item) => item.key)).toContain('access_control');
    expect(body.user.role).toBe('super_admin');
    expect(body.scope).toEqual({ countryId: null, tenantId: null, merchantId: null });
    // Counted from the seed migrations, not copied here (T-069). The literal used to read 8 —
    // correct for T004_002 alone, wrong once T042_002 added `definition_requests`. The task file
    // said 7, the design doc 8, the database now 9; a copied number has been wrong at every step,
    // which is the argument for not copying one.
    expect(body.nav).toHaveLength(seededNavKeys('super_admin').length);
  });

  it('TC-2: country_admin has NO access_control, and scope is country-only', async () => {
    const { body } = await bootstrapOf('country');

    expect(body.nav.map((item) => item.key)).not.toContain('access_control');
    expect(body.scope).toEqual({ countryId, tenantId: null, merchantId: null });
    expect(body.nav).toHaveLength(seededNavKeys('country_admin').length);
  });

  it('TC-3: tenant_admin has both country and tenant in scope, and the seeded nav', async () => {
    const { body } = await bootstrapOf('tenant');

    expect(body.scope).toEqual({ countryId, tenantId, merchantId: null });
    expect(body.nav).toHaveLength(seededNavKeys('tenant_admin').length);
  });

  it('TC-4: maker has campaign:create and rule is view-only', async () => {
    const { body } = await bootstrapOf('maker');

    expect(body.permissions.campaign).toContain('create');
    expect(body.permissions.rule).toEqual(['view']);
    expect(body.nav).toHaveLength(seededNavKeys('maker').length);
  });

  it('TC-5: checker has the approvals menu and campaign:approve', async () => {
    const { body } = await bootstrapOf('checker');

    expect(body.nav.map((item) => item.key)).toContain('approvals');
    expect(body.permissions.campaign).toContain('approve');
    expect(body.nav).toHaveLength(seededNavKeys('checker').length);
  });

  it('TC-6: merchant has merchantId in scope and the seeded nav', async () => {
    const { body } = await bootstrapOf('merchant');

    expect(body.scope).toEqual({ countryId, tenantId, merchantId });
    expect(body.nav).toHaveLength(seededNavKeys('merchant').length);
  });

  it('every role receives the message catalogue and its own permission map', async () => {
    for (const key of Object.keys(roleOf)) {
      const { body } = await bootstrapOf(key);

      expect(Object.keys(body.messages).length).toBeGreaterThan(0);
      expect(Object.keys(body.permissions).length).toBeGreaterThan(0);
      expect(body.user.role).toBe(roleOf[key]);
    }
  });

  it('the six payloads are genuinely distinct — no role is served another’s config', async () => {
    const signatures = new Set<string>();
    for (const key of Object.keys(roleOf)) {
      const { body } = await bootstrapOf(key);
      signatures.add(JSON.stringify([body.nav, body.widgets, body.permissions]));
    }

    expect(signatures.size).toBe(6);
  });
});

// --- T-069 — the expectations above must not go stale again ------------------------------------

describe('T-069 — the seeded-nav source this suite asserts against', () => {
  /**
   * The regression guard for this task's own defect, and the reason it is a *static* check.
   *
   * Every nav expectation in this file now derives from `NAV_SEED_MIGRATIONS`, so the whole suite
   * is only as correct as that list is complete. The original bug was precisely an incomplete list
   * — and nothing failed until eleven unrelated assertions did, in a way that read like an endpoint
   * regression rather than a stale fixture. This test names the real condition: a migration that
   * writes to `role_nav_configs` and is not registered above.
   *
   * Scanning the migration sources rather than the database is deliberate. A migration is
   * registered here the moment it is *written*, not once someone remembers to run `db:migrate`, so
   * this fails in the pull request that introduces the drift rather than on whichever machine
   * happens to be migrated furthest.
   */
  it('covers every migration that seeds role_nav_configs', () => {
    const migrationsDir = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
    const seedingFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) =>
        /INSERT\s+INTO\s+reward_config\.role_nav_configs/i.test(
          fs.readFileSync(path.join(migrationsDir, file), 'utf8'),
        ),
      )
      .sort();

    expect(seedingFiles).toEqual(NAV_SEED_MIGRATIONS.map((migration) => migration.file).sort());
  });

  /**
   * ...and that the constants are not fiction: every row they declare is really in the table.
   *
   * The opposite direction — an *unregistered* row in the database — is already covered, and more
   * sharply, by the per-role `nav is exactly the seeded menu` assertions above: an extra enabled
   * row shows up in `body.nav` and fails the `toEqual` outright. This half only asserts presence,
   * which keeps it immune to the leftover rows a shared dev database accumulates (cf. T-070).
   */
  it('matches the rows those migrations actually wrote to the database', async () => {
    const rows = await sql<{ role: string; nav_key: string }>(
      `SELECT role, nav_key FROM reward_config.role_nav_configs`,
    );
    const present = new Set(rows.map((row) => `${row.role}/${row.nav_key}`));

    const missing = SEEDED_NAV_ROWS.map((row) => `${row.role}/${row.navKey}`)
      .filter((key) => !present.has(key))
      .sort();

    expect(missing).toEqual([]);
  });
});

// --- TC-7, TC-8, TC-10, TC-11 — configuration changes ------------------------------------------

describe('TC-7 / verification steps 3 and 4 — disabling a nav row', () => {
  it('removes the item, and re-enabling brings it back', async () => {
    const before = (await bootstrapOf('maker')).body.nav.map((item) => item.key);
    expect(before).toContain('campaign_new');

    await withNavRow(
      'maker',
      'campaign_new',
      `UPDATE reward_config.role_nav_configs SET enabled = false, updated_at = now()
        WHERE role = :role AND nav_key = :navKey`,
      {},
      async () => {
        const during = (await bootstrapOf('maker')).body.nav.map((item) => item.key);
        expect(during).not.toContain('campaign_new');
        // The seeded menu minus exactly the disabled row, order preserved — derived rather than
        // written out, so a new maker nav row does not turn this into a false failure (T-069).
        expect(during).toEqual(seededNavKeys('maker').filter((key) => key !== 'campaign_new'));
      },
    );

    const after = (await bootstrapOf('maker')).body.nav.map((item) => item.key);
    expect(after).toEqual(before);
  });

  it('takes effect without an rbac_version bump, because an unconditional GET re-reads', async () => {
    // The point of not caching the nav tables in-process: the ETag governs conditional requests
    // only, so a Super Admin toggling a row sees it on the next plain GET.
    await withNavRow(
      'checker',
      'approvals',
      `UPDATE reward_config.role_nav_configs SET enabled = false, updated_at = now()
        WHERE role = :role AND nav_key = :navKey`,
      {},
      async () => {
        const { body } = await bootstrapOf('checker');
        expect(body.nav.map((item) => item.key)).not.toContain('approvals');
      },
    );
  });
});

describe('TC-8 — disabling a parent takes its children with it', () => {
  /**
   * The seed has no parented rows at all (§5.2), so the parent/child relationship is created here
   * by re-parenting one existing merchant row under the other — an UPDATE that is restored
   * afterwards — rather than by inserting rows this suite could not delete (`reward_app` has no
   * DELETE on `reward_config`).
   */
  it('nests a real child, then drops parent and child together when the parent is disabled', async () => {
    await withNavRow(
      'merchant',
      'campaigns',
      `UPDATE reward_config.role_nav_configs SET parent_nav_key = 'dashboard', updated_at = now()
        WHERE role = :role AND nav_key = :navKey`,
      {},
      async () => {
        const nested = (await bootstrapOf('merchant')).body;

        expect(nested.nav.map((item) => item.key)).toEqual(['dashboard']);
        expect(nested.nav[0].children.map((child) => child.key)).toEqual(['campaigns']);

        await withNavRow(
          'merchant',
          'dashboard',
          `UPDATE reward_config.role_nav_configs SET enabled = false, updated_at = now()
            WHERE role = :role AND nav_key = :navKey`,
          {},
          async () => {
            const orphaned = (await bootstrapOf('merchant')).body;

            // Both gone. The bug this asserts against would show `campaigns` promoted to the top
            // level, i.e. a menu entry inside a section the administrator has just switched off.
            expect(orphaned.nav).toEqual([]);
            expect(JSON.stringify(orphaned.nav)).not.toContain('campaigns');
          },
        );
      },
    );

    // Restored to the flat seeded menu.
    expect((await bootstrapOf('merchant')).body.nav.map((item) => item.key)).toEqual([
      'dashboard',
      'campaigns',
    ]);
  });
});

describe('TC-10 — changing sort_order', () => {
  it('reorders the menu on the next bootstrap', async () => {
    await withNavRow(
      'maker',
      'campaign_new',
      `UPDATE reward_config.role_nav_configs SET sort_order = 5, updated_at = now()
        WHERE role = :role AND nav_key = :navKey`,
      {},
      async () => {
        const { body } = await bootstrapOf('maker');
        // The same seeded rows re-sorted with `campaign_new` at 5 — the reorder is applied to the
        // seed and then sorted by the endpoint's own comparator, rather than asserted as a literal
        // list that a new maker nav row would invalidate (T-069). `campaign_new` moving to the
        // front is still asserted explicitly below, so this stays a real ordering test.
        const reordered = seededNavKeys(
          'maker',
          SEEDED_NAV_ROWS.map((row) =>
            row.role === 'maker' && row.navKey === 'campaign_new' ? { ...row, sortOrder: 5 } : row,
          ),
        );

        expect(reordered[0]).toBe('campaign_new');
        expect(body.nav.map((item) => item.key)).toEqual(reordered);
      },
    );

    expect((await bootstrapOf('maker')).body.nav.map((item) => item.key)).toEqual(
      seededNavKeys('maker'),
    );
  });
});

describe('TC-11 — a malformed widget_config', () => {
  it('yields {} for that widget and still returns 200', async () => {
    const widgetKey = 'kpi_active_campaigns';
    const [before] = await sql<{ widget_config: string | null }>(
      `SELECT widget_config FROM reward_config.role_dashboard_widgets
        WHERE role = 'merchant' AND widget_key = :widgetKey`,
      { widgetKey },
    );

    try {
      await exec(
        `UPDATE reward_config.role_dashboard_widgets
            SET widget_config = '{not valid json', updated_at = now()
          WHERE role = 'merchant' AND widget_key = :widgetKey`,
        { widgetKey },
      );

      const { response, body } = await bootstrapOf('merchant');

      expect(response.status).toBe(200);
      expect(body.widgets.find((widget) => widget.key === widgetKey)?.config).toEqual({});
      // The rest of the dashboard is unaffected — one bad row must not empty the response.
      expect(body.widgets.map((widget) => widget.key)).toEqual(seededWidgetKeys('merchant'));
    } finally {
      await exec(
        `UPDATE reward_config.role_dashboard_widgets
            SET widget_config = :config, updated_at = now()
          WHERE role = 'merchant' AND widget_key = :widgetKey`,
        { widgetKey, config: before?.widget_config ?? null },
      );
    }
  });
});

// --- TC-12, TC-13 — caching -------------------------------------------------------------------

describe('TC-12 / verification step 5 — conditional requests', () => {
  it('sends a weak ETag, `private, no-cache` and `Vary: Cookie`', async () => {
    const { response } = await bootstrapOf('maker');

    expect(response.headers.etag).toMatch(/^W\/"maker-\d+-\d+"$/);
    expect(response.headers['cache-control']).toBe(SHARED_CACHE_CONTROL);
    expect(response.headers.vary).toContain('Cookie');
  });

  it('answers 304 with an empty body when the ETag is re-presented', async () => {
    const first = await get('maker', '/me/bootstrap');
    const etag = first.headers.etag;

    const second = await get('maker', '/me/bootstrap').set('If-None-Match', etag);

    expect(second.status).toBe(304);
    expect(second.text).toBe('');
    expect(second.body).toEqual({});
    // The client must be able to revalidate again next time.
    expect(second.headers.etag).toBe(etag);
  });

  it('answers 304 for every role, each with its own tag', async () => {
    const tags = new Set<string>();

    for (const key of ['super', 'country', 'tenant', 'maker', 'checker', 'merchant']) {
      const first = await get(key, '/me/bootstrap');
      tags.add(first.headers.etag);

      const second = await get(key, '/me/bootstrap').set('If-None-Match', first.headers.etag);
      expect(second.status).toBe(304);
    }

    // Six roles, six distinct tags: no cross-role 304 is possible.
    expect(tags.size).toBe(6);
  });

  it('does NOT 304 another role’s ETag', async () => {
    const checkerTag = (await get('checker', '/me/bootstrap')).headers.etag;

    const response = await get('maker', '/me/bootstrap').set('If-None-Match', checkerTag);

    expect(response.status).toBe(200);
  });
});

describe('TC-13 — bumping rbac_version defeats a held ETag', () => {
  it('returns 200 with fresh data for the old tag', async () => {
    const stale = (await get('maker', '/me/bootstrap')).headers.etag;

    await withRbacVersionBump('maker', async () => {
      const response = await get('maker', '/me/bootstrap').set('If-None-Match', stale);

      expect(response.status).toBe(200);
      expect(response.headers.etag).not.toBe(stale);
      expect(bootstrapEnvelopeSchema.safeParse(response.body).success).toBe(true);
    });
  });

  it('the version is read live, not from the 15-minute-old token claim', async () => {
    // The actor's JWT was minted in `beforeAll` and carries the version as it was then. If the
    // ETag were built from that claim it could not move inside this block.
    const before = (await get('checker', '/me/bootstrap')).headers.etag;

    await withRbacVersionBump('checker', async () => {
      const during = (await get('checker', '/me/bootstrap')).headers.etag;
      expect(during).not.toBe(before);
    });
  });
});

// --- TC-14, TC-15 — access and disclosure -------------------------------------------------------

describe('TC-14 — an unauthenticated request', () => {
  it('is 401 on every /me route', async () => {
    for (const route of ['/api/v1/me/bootstrap', '/api/v1/me']) {
      const response = await http().get(route);
      expect(response.status).toBe(401);
    }
  });

  it('leaks no configuration in the 401 body', async () => {
    const response = await http().get('/api/v1/me/bootstrap');

    expect(JSON.stringify(response.body)).not.toContain('dashboard');
    expect(JSON.stringify(response.body)).not.toContain('permissions');
  });

  it('a session confined by must_change_password is refused (02-SECURITY.md §2)', async () => {
    // "restricts the session to exactly two endpoints (`/auth/change-password`, `/auth/logout`)".
    const response = await get('confined', '/me/bootstrap');

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'PASSWORD_CHANGE_REQUIRED');
  });
});

describe('TC-15 — nothing sensitive, and nobody else’s data', () => {
  it('carries no credential, session or MFA material for any role', async () => {
    for (const key of ['super', 'country', 'tenant', 'maker', 'checker', 'merchant']) {
      const { response } = await bootstrapOf(key);
      // Walks every property name in the payload, and shape-asserts the two members whose keys
      // are data rather than field names — see `support/secret-scan.ts`.
      expectBootstrapDisclosure(response.body, `${key}.response`);
    }
  });

  it('names no other user — not an email, not a display name, not an id', async () => {
    const others = [...actors.values()].filter((actor) => actor.key !== 'maker');
    const { response } = await bootstrapOf('maker');
    const serialised = JSON.stringify(response.body);

    for (const other of others) {
      expect(serialised).not.toContain(other.email);
      expect(serialised).not.toContain(`T-015 ${other.key}`);
    }
    expect(response.body.data.user.id).toBe(as('maker').userId);
  });

  it('GET /me returns the caller’s own profile and matches the shared schema', async () => {
    const response = await get('maker', '/me');

    expect(response.status).toBe(200);
    expect(meProfileEnvelopeSchema.safeParse(response.body).success).toBe(true);
    expect(response.body.data.email).toBe(as('maker').email);
    expectNoSecretMaterial(response.body);
  });
});

// --- TC-16, TC-17, TC-18 — PATCH /me -----------------------------------------------------------

describe('TC-16 / verification step 6 — PATCH /me with a role', () => {
  it('is 400 and the role in the database is unchanged', async () => {
    const response = await patch('maker', '/me', { role: 'super_admin' });

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
    expect(response.body.error.details).toEqual([{ field: 'role', code: 'UNEXPECTED_FIELD' }]);

    const [row] = await sql<{ role: string }>(
      `SELECT role FROM reward_portal.portal_users WHERE id = :id`,
      { id: as('maker').userId },
    );
    expect(row.role).toBe('maker');
  });

  it('is 400 even when a legitimate field is sent alongside it', async () => {
    const response = await patch('maker', '/me', { displayName: 'Nice Try', role: 'super_admin' });

    expect(response.status).toBe(400);

    const [row] = await sql<{ role: string; display_name: string }>(
      `SELECT role, display_name FROM reward_portal.portal_users WHERE id = :id`,
      { id: as('maker').userId },
    );
    // Neither field was applied — the request was rejected whole, not partially honoured.
    expect(row.role).toBe('maker');
    expect(row.display_name).toBe('T-015 maker');
  });

  it('the caller’s permissions are unchanged afterwards', async () => {
    await patch('maker', '/me', { role: 'super_admin' });

    const { body } = await bootstrapOf('maker');
    expect(body.user.role).toBe('maker');
    expect(body.nav.map((item) => item.key)).not.toContain('access_control');
  });
});

describe('TC-17 — PATCH /me with a scope field', () => {
  it.each([
    ['tenantId', 999],
    ['countryId', 999],
    ['merchantId', 999],
    ['status', 'active'],
    ['id', 1],
    ['email', 'someone.else@example.invalid'],
    ['mustChangePassword', false],
  ])('is 400 for %s, and the scope is unchanged', async (field, value) => {
    const response = await patch('maker', '/me', { [field]: value });

    expect(response.status).toBe(400);

    const [row] = await sql<{
      country_id: number;
      tenant_id: number;
      merchant_id: number | null;
      status: string;
      email: string;
    }>(
      `SELECT country_id, tenant_id, merchant_id, status, email
         FROM reward_portal.portal_users WHERE id = :id`,
      { id: as('maker').userId },
    );

    expect(row.country_id).toBe(countryId);
    expect(row.tenant_id).toBe(tenantId);
    expect(row.merchant_id).toBeNull();
    expect(row.status).toBe('active');

    // T-056: this is a *raw* read, so the column holds the envelope rather than the address —
    // which is exactly the property this task exists to establish. Assert both halves: the stored
    // value is not the plaintext, and it still decrypts back to the unchanged address.
    expect(row.email).not.toBe(as('maker').email);
    expect(row.email).toMatch(/^v1\./);
    expect(emailCrypto.decryptForRow(as('maker').userId, row.email)).toBe(as('maker').email);
  });
});

describe('TC-18 — PATCH /me with displayName', () => {
  afterEach(async () => {
    await exec(
      `UPDATE reward_portal.portal_users
          SET display_name = 'T-015 tenant', preferred_locale = 'en',
              preferred_timezone = 'Asia/Kolkata'
        WHERE id = :id`,
      { id: as('tenant').userId },
    );
  });

  it('is 200 and changes only that field', async () => {
    const [before] = await sql<Record<string, unknown>>(
      `SELECT * FROM reward_portal.portal_users WHERE id = :id`,
      { id: as('tenant').userId },
    );

    const response = await patch('tenant', '/me', { displayName: 'New Name' });

    expect(response.status).toBe(200);
    expect(response.body.data.displayName).toBe('New Name');

    const [after] = await sql<Record<string, unknown>>(
      `SELECT * FROM reward_portal.portal_users WHERE id = :id`,
      { id: as('tenant').userId },
    );

    // Every column except `display_name` and `updated_at` is byte-identical.
    const ignored = new Set(['display_name', 'updated_at']);
    for (const column of Object.keys(before)) {
      if (ignored.has(column)) continue;
      expect({ column, value: after[column] }).toEqual({ column, value: before[column] });
    }
    expect(after.display_name).toBe('New Name');
  });

  it('accepts locale and timezone, and rejects an invalid timezone', async () => {
    await expect(
      patch('tenant', '/me', { preferredLocale: 'fr-CA', preferredTimezone: 'Europe/Paris' }),
    ).resolves.toMatchObject({ status: 200 });

    const rejected = await patch('tenant', '/me', { preferredTimezone: 'Mars/Olympus_Mons' });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.details).toEqual([
      { field: 'preferredTimezone', code: 'IS_IANA_TIME_ZONE' },
    ]);
  });

  it('an empty patch is a 200 no-op', async () => {
    const response = await patch('tenant', '/me', {});

    expect(response.status).toBe(200);
    expect(response.body.data.displayName).toBe('T-015 tenant');
  });

  it('changes the bootstrap ETag, so the caller’s other tabs refetch', async () => {
    const before = (await get('tenant', '/me/bootstrap')).headers.etag;

    await patch('tenant', '/me', { displayName: 'Renamed For ETag' });

    const after = await get('tenant', '/me/bootstrap').set('If-None-Match', before);
    expect(after.status).toBe(200);
    expect(after.headers.etag).not.toBe(before);
    expect(after.body.data.user.displayName).toBe('Renamed For ETag');
  });

  it('is rejected without a CSRF token — it is a mutating request', async () => {
    const response = await http()
      .patch('/api/v1/me')
      .set('Cookie', as('tenant').jar)
      .send({ displayName: 'No CSRF' });

    expect(response.status).toBe(403);
  });

  it('writes a portal_audit_log row naming the fields, never their values', async () => {
    await patch('tenant', '/me', { displayName: 'Audited Name' });

    const [row] = await sql<{ event_type: string; target_id: string; detail: unknown }>(
      `SELECT event_type, target_id, detail FROM reward_portal.portal_audit_log
        WHERE actor_id = :id AND event_type = 'profile_updated'
        ORDER BY id DESC LIMIT 1`,
      { id: as('tenant').userId },
    );

    expect(row.event_type).toBe('profile_updated');
    expect(row.target_id).toBe(String(as('tenant').userId));
    expect(JSON.stringify(row.detail)).toContain('displayName');
    expect(JSON.stringify(row.detail)).not.toContain('Audited Name');
  });
});

// --- TC-19, TC-20 — performance and concurrency -------------------------------------------------

describe('TC-19 — latency', () => {
  it('p95 over 100 warm requests is under 100 ms', async () => {
    // Warm: the connection pool, the permission cache and the message catalogue are all primed by
    // the suites above, which is the state a logged-in user's revalidation actually meets.
    for (let index = 0; index < 10; index += 1) await get('maker', '/me/bootstrap');

    const timings: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const started = process.hrtime.bigint();
      const response = await get('maker', '/me/bootstrap');
      timings.push(Number(process.hrtime.bigint() - started) / 1e6);
      expect(response.status).toBe(200);
    }

    timings.sort((left, right) => left - right);
    const p95 = timings[Math.ceil(timings.length * 0.95) - 1];

    // eslint-disable-next-line no-console
    console.log(
      `TC-19: p50=${timings[49].toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${timings[99].toFixed(1)}ms`,
    );
    expect(p95).toBeLessThan(100);
  });

  it('a 304 is faster than a 200, which is the point of the two-phase read', async () => {
    const etag = (await get('maker', '/me/bootstrap')).headers.etag;

    const timeOf = async (conditional: boolean): Promise<number> => {
      const samples: number[] = [];
      for (let index = 0; index < 30; index += 1) {
        const call = get('maker', '/me/bootstrap');
        const started = process.hrtime.bigint();
        await (conditional ? call.set('If-None-Match', etag) : call);
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
      samples.sort((left, right) => left - right);
      return samples[14];
    };

    const conditional = await timeOf(true);
    const full = await timeOf(false);

    // eslint-disable-next-line no-console
    console.log(`TC-19: median 304=${conditional.toFixed(1)}ms · median 200=${full.toFixed(1)}ms`);
    expect(conditional).toBeLessThanOrEqual(full);
  });
});

describe('TC-20 — two roles concurrently', () => {
  it('each receives its own role’s config, with no bleed', async () => {
    const plan = [
      { key: 'maker', nav: seededNavKeys('maker') },
      { key: 'merchant', nav: seededNavKeys('merchant') },
      { key: 'super', nav: seededNavKeys('super_admin') },
      { key: 'checker', nav: seededNavKeys('checker') },
    ];

    // 120 requests, 20 genuinely in flight at a time, interleaved across four roles — the
    // condition an AsyncLocalStorage or a shared-cache leak needs in order to show itself.
    const CONCURRENCY = 20;
    const results: {
      expected: string[];
      body: { nav: { key: string }[]; user: { role: string } };
    }[] = [];

    for (let start = 0; start < 120; start += CONCURRENCY) {
      const batch = Array.from({ length: CONCURRENCY }, (_, offset) => plan[(start + offset) % 4]);
      const responses = await Promise.all(
        batch.map((entry) =>
          get(entry.key, '/me/bootstrap').then((response) => {
            expect(response.status).toBe(200);
            return { expected: entry.nav, body: response.body.data };
          }),
        ),
      );
      results.push(...responses);
    }

    for (const result of results) {
      expect(result.body.nav.map((item) => item.key)).toEqual(result.expected);
    }

    // And every role really was exercised, so the loop above is not vacuous.
    expect(new Set(results.map((result) => result.body.user.role)).size).toBe(4);
  });
});
