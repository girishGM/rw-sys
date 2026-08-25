/**
 * T-051 — **the maximally over-granted role**: what `role_entity_permissions` can actually buy.
 *
 * ## Why this file exists (added on the second re-verification pass, 2026-08-23)
 *
 * The first pass of this audit raised finding **F-2**: "116 of 174" routes carry
 * `@RequirePermission` but no `@Roles`, and concluded that on those routes *"the only thing
 * between a role and the endpoint is a row in `role_entity_permissions`, which is runtime-editable
 * through `/admin/access-control`. A single wrong row grants a `merchant` `POST /countries`."*
 *
 * **Both halves of that turn out to be wrong, and this suite is what establishes it.** The count
 * is 103, not 116 (the reconciliation test below re-derives all four classes from the running
 * router: 9 public + 62 `@Roles` + 103 permission-only + 0 unguarded = 174). The original 9/49/116
 * split also sums to 174, which is precisely why the error survived — the total reconciled, so the
 * parts were never checked.
 *
 * That conclusion was **never measured**. It was asserted in `role-matrix.spec.ts` against
 * `expectedOutcome(...)` — this audit's *own model* of the guard chain, which knows about exactly
 * two things, `@Roles` metadata and the permission table. A model that does not model the service
 * layer cannot produce evidence about the service layer; it can only restate its own assumptions.
 * AGENT-PROTOCOL §3 names this failure mode precisely:
 *
 * > Ask of each security-critical test: *if the specified value were wrong, would this test still
 * > pass?* If yes, it is a change-detector, not a test.
 *
 * If `POST /countries` had a hard role floor in code, `role-matrix.spec.ts`'s F-2 assertions would
 * have passed anyway. They did, and it does. `CountriesService.create` opens with
 * `assertRole(actor, 'super_admin')` — the function whose own header describes T-013 TC-19 as
 * *"`maker` granted `rule:create` by editing the DB, then calls `POST /rules` → 403 — service-layer
 * assertion overrides the table"*, which is F-2's scenario exactly, already anticipated and already
 * defended. F-2 was a finding about the decorators, reported as a finding about the architecture.
 *
 * ## What this file measures instead
 *
 * The question F-2 should have asked is not *"how many routes lack `@Roles`"* — that is a property
 * of the source text — but:
 *
 * > **If `role_entity_permissions` were maximally wrong, what could the weakest role actually
 * > reach?**
 *
 * So this suite grants a real `merchant` session **every entity × action in the catalogue**, through
 * the real `PUT /admin/access-control/permissions/merchant` endpoint driven by a real `super_admin`
 * session — the exact runtime-editable path F-2 names as the threat — and then re-probes every
 * layer-2-only route and diffs the result against the same sweep taken before the grant.
 *
 * The set of routes whose status changes **is** F-2's true population, measured rather than
 * counted from decorators. The set that does not change is the set where a second, data-free layer
 * exists in code and F-2's premise is simply false.
 *
 * ## Correction, fourth pass 2026-08-23 — read the paragraphs above with this one
 *
 * Everything above is still true **of the routes it measured**, and its conclusion was over-general.
 * The third pass sent a valid body to three delegated *creation* boundaries (`countries`, `tenants`,
 * `merchants`), found `assertRole` behind each, and concluded F-2 was refuted; it recorded, to its
 * credit, that the other 100 layer-2-only routes had been checked by **grep** and that *"a route
 * whose service forgot its `assertRole` would not have been caught."*
 *
 * One had. `role-floor-inventory.ts` (added below, and written precisely to stop trusting the grep)
 * resolves all 55 layer-2-only mutating routes to the service method behind them: 50 are floored,
 * two are legitimately self-scoped, and **three `/users` writes have no role floor anywhere** —
 * neither decorator nor service. The probe at the foot of this file then does for `/users` what the
 * third pass did for `/countries`, and gets the opposite answer: an over-granted `maker` resets its
 * own `tenant_admin`'s password, is handed the new password in the response body, and logs in as
 * them. That is finding **F-12**, filed as **T-088**, and it means F-2's *mechanism* — one wrong row in a
 * runtime-editable table is enough — was right all along, on a population F-2 never looked at.
 *
 * The lesson the third pass drew ("an audit finding that has never been executed against the running
 * system is a hypothesis") holds in both directions, and this is the other one: **a refutation that
 * has only been executed against three of 103 members of a population is also a hypothesis.**
 *
 * ## Safety
 *
 * This suite mutates `reward_config.role_entity_permissions`, a live shared table, which no other
 * test here does. Four things keep that safe, in order of how much they are relied on:
 *
 *  1. **The edit goes through the application's own endpoint**, not raw SQL — so it is validated,
 *     audited, version-checked and reversible by the same route that made it.
 *  2. **`afterAll` restores unconditionally** (`try`/`finally` around the whole experiment, plus a
 *     final restore in `afterAll` that runs even if every test failed), and the restore is
 *     *verified* by re-reading the matrix and comparing it to the captured original.
 *  3. **`beforeAll` refuses to start from a contaminated baseline.** If a previous killed run left
 *     the merchant holding `country:create`, the capture would record the contamination as the
 *     thing to restore. The assertion below fails loudly instead.
 *  4. **Every probe uses `IMPOSSIBLE_ID` path parameters and an empty body**, so an admitted route
 *     reaches `ValidationPipe` (400) or a missing row (404) and writes nothing. This is the same
 *     non-mutating probe technique `role-matrix.e2e-spec.ts` documents and relies on.
 */
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
import { asExpressApplication, configureHttpSecurity } from '@/common/security/security.middleware';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import {
  MemoryThrottleStore,
  THROTTLE_STORE,
  type ThrottleCounter,
  type ThrottleStore,
} from '@/common/security/throttle.store';
import {
  ENTITY_ACTION_CATALOGUE,
  PROTECTED_PERMISSIONS,
} from '@/modules/access-control/access-control.constants';
import type { PortalRole } from '@/database/portal-models';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import { loginCompletingMfa } from '../auth/support/super-admin-mfa';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import { classify, collectGuardedRoutes, type GuardedRoute } from './support/route-guard-inventory';
import { resolveRoleFloors } from './support/role-floor-inventory';
import { bindTestServer } from './support/bound-app';

jest.setTimeout(900_000);

/** Namespaces this suite's `encryption_keys` rows, so two suites cannot delete each other's. */
const SUITE = 't051f2';

const PASSWORD = 'correct horse battery staple 7!';
/** `countries.code` is `character(2)`; distinct from every other suite's fixture. */
const HOME_COUNTRY = 'ZP';
const HOME_TENANT = 'T051F2_HOME';
const HOME_MERCHANT = 'T051F2_M_HOME';

/** A primary key no row has. Used wherever a path parameter must resolve to nothing. */
const IMPOSSIBLE_ID = 999_999_999;

/** Routes that would end the session the sweep is conducted with. Never probed here. */
const SESSION_DESTROYING = new Set(['POST /api/v1/auth/logout', 'POST /api/v1/auth/logout-all']);

/**
 * `403` is the guard chain's refusal *and* `assertRole`'s refusal — both are `PERM_DENIED`, by
 * design (a service-layer denial that looked different would tell an attacker which layer stopped
 * them). So a status alone cannot separate "refused by a guard" from "refused in the service";
 * the *diff between the two sweeps* can, which is why this suite is built as a diff.
 */
const DENIED = 403;

interface Actor {
  readonly role: PortalRole;
  readonly email: string;
  readonly userId: number;
  readonly jar: string;
  readonly csrf: string;
}

interface PermissionsPayload {
  readonly role: string;
  readonly version: number;
  readonly permissions: Record<string, string[]>;
}

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;
let store: ResettableThrottleStore;
let routes: GuardedRoute[];
let baseUrl: string;

let superAdmin: Actor;
let merchant: Actor;
/** Fourth pass, the `/users` probe: the over-granted attacker and the peer it targets. */
let maker: Actor;
let tenantAdmin: Actor;

/** The maker's permission matrix exactly as found — what the `/users` probe must put back. */
let originalMakerPermissions: Record<string, string[]> | undefined;
/** True once the maker over-grant has been applied and not yet reverted. */
let makerGranted = false;

/** The merchant's permission matrix exactly as found. The thing `afterAll` must put back. */
let originalMerchantPermissions: Record<string, string[]>;
/** True once the over-grant has been applied and not yet reverted. */
let granted = false;

/** Statuses keyed by route signature, from the sweep before the over-grant. */
const before = new Map<string, number>();
/** The same, after the over-grant. */
const after = new Map<string, number>();

const HOME = { countryId: 0, tenantId: 0, merchantId: 0 };

class ResettableThrottleStore implements ThrottleStore {
  readonly kind = 'memory' as const;
  private delegate = new MemoryThrottleStore();

  async consume(key: string, windowMs: number, now: number): Promise<ThrottleCounter> {
    return this.delegate.consume(key, windowMs, now);
  }

  clear(): void {
    this.delegate = new MemoryThrottleStore();
  }
}

function http() {
  return request(baseUrl);
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

function setCookieHeaders(response: request.Response): string[] {
  const header = response.headers['set-cookie'];
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [header];
}

function jarFrom(response: request.Response): string {
  return setCookieHeaders(response)
    .map((entry) => entry.split(';')[0])
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

function csrfFrom(response: request.Response): string {
  const cookie = setCookieHeaders(response).find((entry) =>
    entry.startsWith(`${CSRF_COOKIE_NAME}=`),
  );
  if (cookie === undefined) throw new Error('login set no CSRF cookie');
  return decodeURIComponent(cookie.split(';')[0].split('=')[1]);
}

/** Fills every path parameter with a value that resolves to no row. */
function probePath(route: GuardedRoute): string {
  return `/api/v1${route.path}`
    .replace(/:level\b/g, '1')
    .replace(/:role\b/g, 'merchant')
    .replace(/:policyKey\b/g, 't051f2-nonexistent-policy')
    .replace(/:correlationId\b/g, '00000000-0000-4000-8000-000000000000')
    .replace(/:[A-Za-z]+/g, String(IMPOSSIBLE_ID));
}

type Verb = 'get' | 'post' | 'put' | 'patch' | 'delete';

function send(actor: Actor, route: GuardedRoute, path: string, body: unknown = {}): request.Test {
  const verb = route.method.toLowerCase() as Verb;
  const call = http()[verb](path).set('Cookie', actor.jar);
  if (verb === 'get') return call;
  return call.set('X-CSRF-Token', actor.csrf).send(body as object);
}

/**
 * The routes this experiment is about: guarded, non-public, carrying `@RequirePermission` and
 * **no** `@Roles`. These are F-2's population, taken from the running router rather than counted
 * by hand.
 */
function layerTwoOnly(): GuardedRoute[] {
  return routes.filter(
    (route) =>
      !route.isPublic &&
      route.permission !== undefined &&
      route.roles === undefined &&
      !SESSION_DESTROYING.has(route.signature),
  );
}

/** Probes every layer-2-only route as the merchant and records the status against `into`. */
async function sweep(into: Map<string, number>): Promise<void> {
  into.clear();
  let sinceReset = 0;
  for (const route of layerTwoOnly()) {
    if (sinceReset++ >= 120) {
      store.clear();
      sinceReset = 0;
    }
    const response = await send(merchant, route, probePath(route));
    into.set(route.signature, response.status);
  }
}

async function readPermissions(role: PortalRole): Promise<PermissionsPayload> {
  const response = await http()
    .get(`/api/v1/admin/access-control/permissions/${role}`)
    .set('Cookie', superAdmin.jar);
  if (response.status !== 200) {
    throw new Error(
      `GET permissions/${role} → ${response.status} ${JSON.stringify(response.body)}`,
    );
  }
  return response.body.data as PermissionsPayload;
}

/** Writes `permissions` for `role` through the real endpoint, re-reading the version first. */
async function writePermissions(
  role: PortalRole,
  permissions: Record<string, string[]>,
): Promise<void> {
  const current = await readPermissions(role);
  const response = await http()
    .put(`/api/v1/admin/access-control/permissions/${role}`)
    .set('Cookie', superAdmin.jar)
    .set('X-CSRF-Token', superAdmin.csrf)
    .send({ expectedVersion: current.version, permissions });
  if (response.status !== 200) {
    throw new Error(
      `PUT permissions/${role} → ${response.status} ${JSON.stringify(response.body)}`,
    );
  }
}

/**
 * Every grantable cell except the six `rule`/`reward` authoring cells, which
 * `PROTECTED_PERMISSIONS` makes ungrantable to a non-`super_admin` role — the endpoint rejects
 * the whole payload if they are included, so including them would measure nothing but a 400.
 *
 * That rejection is itself a second layer for those six cells, and it is asserted separately
 * below rather than silently relied on here.
 */
function maximalGrantForNonSuperAdmin(): Record<string, string[]> {
  const grant: Record<string, string[]> = {};
  for (const [entity, actions] of Object.entries(ENTITY_ACTION_CATALOGUE)) {
    const allowed = actions.filter(
      (action) => !PROTECTED_PERMISSIONS.some((p) => p.entity === entity && p.action === action),
    );
    if (allowed.length > 0) grant[entity] = [...allowed];
  }
  return grant;
}

// --- fixtures ---------------------------------------------------------------------------------

async function ensureCountry(code: string, name: string): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.countries WHERE code = :code`,
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
     VALUES (:code, :name, 'UTC', 'USD', '+000', 'active')
     RETURNING id`,
    { code, name },
  );
  return created.id;
}

async function ensureTenant(code: string, countryId: number): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.tenants WHERE code = :code`,
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
    `SELECT id FROM reward_config.merchants WHERE merchant_code = :code`,
    { code },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.merchants SET status = 'active', deleted_at = NULL, tenant_id = :tenantId
        WHERE id = :id`,
      { id: existing.id, tenantId },
    );
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.merchants (tenant_id, merchant_code, name, country_code, status)
     VALUES (:tenantId, :code, :code, :countryCode, 'active') RETURNING id`,
    { code, tenantId, countryCode },
  );
  return created.id;
}

const FIXTURE_EMAILS: readonly string[] = [
  't051f2-super-admin@example.invalid',
  't051f2-merchant@example.invalid',
  // Added on the fourth pass for the `/users` probe below: the attacker and its victim.
  't051f2-maker@example.invalid',
  't051f2-tenant-admin@example.invalid',
];

/**
 * Real ISO-3166-1 alpha-2 codes (`@IsCountryCode()` rejects invented ones, so the escalation
 * probe cannot use a `ZZ`-style fixture code). Sparsely-populated territories, chosen because
 * they are the least likely to collide with a real seeded country.
 */
const ISO_CANDIDATES = ['AX', 'BV', 'HM', 'IO', 'PN', 'SJ', 'TF', 'UM', 'WF', 'YT'] as const;

/** Set by the escalation probe so `afterAll` can delete the row **if one was created**. */
let probeCountryCode: string | undefined;

/** The first {@link ISO_CANDIDATES} entry with no row in `countries`. */
async function freeIsoCountryCode(): Promise<string> {
  for (const code of ISO_CANDIDATES) {
    const rows = await sql<{ id: number }>(
      `SELECT id FROM reward_config.countries WHERE code = :code`,
      { code },
    );
    if (rows.length === 0) return code;
  }
  throw new Error(`every ISO probe candidate already exists: ${ISO_CANDIDATES.join(', ')}`);
}

async function makeActor(
  role: PortalRole,
  scope: { countryId: number | null; tenantId: number | null; merchantId: number | null },
): Promise<Actor> {
  const email = `t051f2-${role.replace(/_/g, '-')}@example.invalid`;

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-051 F-2 ${role}`,
    role,
    ...scope,
  });

  await exec(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
  );

  const response = await loginCompletingMfa(app, { email, password: PASSWORD }, db);
  if (response.status !== 200) {
    throw new Error(
      `login for ${role} failed: ${response.status} ${JSON.stringify(response.body)}`,
    );
  }

  return { role, email, userId, jar: jarFrom(response), csrf: csrfFrom(response) };
}

beforeAll(async () => {
  store = new ResettableThrottleStore();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(THROTTLE_STORE)
    .useValue(store)
    .compile();

  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), SUITE);

  app = moduleRef.createNestApplication<NestExpressApplication>();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  configureHttpSecurity(asExpressApplication(app), {
    apiOrigin: process.env.API_ORIGIN ?? 'https://api.t051f2.example.test',
    corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS,
    trustProxy: undefined,
    enforceHttps: false,
  });
  baseUrl = await bindTestServer(app);

  db = app.get<Sequelize>(SEQUELIZE);
  emailCrypto = emailCryptoOf(app);
  routes = collectGuardedRoutes(app);

  HOME.countryId = await ensureCountry(HOME_COUNTRY, 'T-051 F-2 Home');
  HOME.tenantId = await ensureTenant(HOME_TENANT, HOME.countryId);
  HOME.merchantId = await ensureMerchant(HOME_MERCHANT, HOME.tenantId, HOME_COUNTRY);

  await deletePortalUsersByEmail(db, emailCrypto, FIXTURE_EMAILS);

  superAdmin = await makeActor('super_admin', {
    countryId: null,
    tenantId: null,
    merchantId: null,
  });
  merchant = await makeActor('merchant', {
    countryId: HOME.countryId,
    tenantId: HOME.tenantId,
    merchantId: HOME.merchantId,
  });
  // The `/users` probe's pair: both tenant-scoped, both in the SAME tenant, so layer 3 cannot
  // separate them. A maker carries no `merchant_id`, which is the whole point — the merchant
  // fixture above is bounded by `merchant_id` as well and so cannot reach a tenant_admin at all.
  maker = await makeActor('maker', {
    countryId: HOME.countryId,
    tenantId: HOME.tenantId,
    merchantId: null,
  });
  tenantAdmin = await makeActor('tenant_admin', {
    countryId: HOME.countryId,
    tenantId: HOME.tenantId,
    merchantId: null,
  });

  const captured = await readPermissions('merchant');
  originalMerchantPermissions = captured.permissions;

  // Guard 3 from the header: never start from a contaminated baseline. If a previous killed run
  // left the over-grant in place, "restore what was found" would restore the contamination.
  expect(originalMerchantPermissions.country ?? []).not.toContain('create');
  expect(originalMerchantPermissions.tenant ?? []).not.toContain('create');
  expect(originalMerchantPermissions.user ?? []).not.toContain('create');

  await sweep(before);
  expect(before.size).toBeGreaterThan(50);

  await writePermissions('merchant', maximalGrantForNonSuperAdmin());
  granted = true;

  store.clear();
  await sweep(after);
});

afterAll(async () => {
  // Guard 2 from the header: restore even if every assertion above failed.
  if (granted && originalMerchantPermissions !== undefined) {
    await writePermissions('merchant', originalMerchantPermissions);
    granted = false;
  }
  // Same guarantee for the second over-grant the `/users` probe applies. Its own `afterAll` runs
  // first and normally clears the flag; this is the backstop for the case where that block itself
  // threw, which is exactly when a live shared table would otherwise be left over-granted.
  if (makerGranted && originalMakerPermissions !== undefined) {
    await writePermissions('maker', originalMakerPermissions);
    makerGranted = false;
  }
  // If the escalation probe DID create a country, this is the only thing that removes it. It runs
  // whether the assertion passed or failed, because a failed assertion is exactly the case where
  // a row exists.
  if (probeCountryCode !== undefined && db !== undefined) {
    await exec(
      `DELETE FROM reward_config.countries WHERE code = :code AND name LIKE 'T-051 F-2%'`,
      {
        code: probeCountryCode,
      },
    );
  }
  if (db !== undefined && emailCrypto !== undefined) {
    await deletePortalUsersByEmail(db, emailCrypto, FIXTURE_EMAILS);
    await removeEncryptionKeys(db, SUITE);
  }
  if (app !== undefined) await app.close();
});

describe('T-051 F-2 re-examined — what a maximally wrong permission table actually buys', () => {
  it('the over-grant really landed, so a null result cannot be a silent no-op', () => {
    // Without this, every "still 403" below would be equally explained by the PUT having failed.
    const maximal = maximalGrantForNonSuperAdmin();
    expect(Object.keys(maximal).length).toBeGreaterThan(10);
    expect(maximal.country).toContain('create');
    expect(maximal.tenant).toContain('create');
    expect(maximal.user).toContain('create');
  });

  it('reads back the over-granted matrix from the live table', async () => {
    const readBack = await readPermissions('merchant');
    expect(readBack.permissions.country).toContain('create');
    expect(readBack.permissions.user).toContain('create');
  });

  it('sweeps the same layer-2-only route population before and after', () => {
    expect(after.size).toBe(before.size);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  });

  /**
   * Reconciles this suite's swept population against `classify()`, because the two disagreed on
   * the first run: `classify().permissionOnly` reported **116** — the number finding F-2 is
   * written around — while the sweep's `Map`, keyed by `route.signature`, held **103**.
   *
   * A `Map` collapses duplicate keys silently, so the gap is the number of registered routes that
   * share a `METHOD /path` signature with another. That is worth an explicit assertion in an audit
   * whose central artefact is a signature-keyed matrix: if two distinct handlers share a
   * signature, the role × endpoint matrix in the report shows one row where the router has two,
   * and the second one is unmeasured.
   *
   * The duplicates are listed on failure rather than summarised, so the next reader does not have
   * to re-derive them.
   */
  it('accounts for every layer-2-only route the router registers, including duplicate signatures', () => {
    const population = layerTwoOnly();
    const seen = new Map<string, number>();
    for (const route of population) {
      seen.set(route.signature, (seen.get(route.signature) ?? 0) + 1);
    }
    const duplicated = [...seen.entries()]
      .filter(([, count]) => count > 1)
      .map(([signature, count]) => `${signature} ×${count}`)
      .sort();

    const classification = classify(routes);

    // eslint-disable-next-line no-console -- T-051: the reconciliation IS the artefact.
    console.log(
      `\nrouter classification (the numbers §11 item 2 is argued from):\n` +
        `  total registered   ${routes.length}\n` +
        `  @Public()          ${classification.publicRoutes.length}\n` +
        `  @Roles (±perm)     ${classification.roleGuarded.length}\n` +
        `  @RequirePermission ${classification.permissionOnly.length}  <- F-2's population\n` +
        `  unguarded          ${classification.unguarded.length}\n` +
        `  sum                ${
          classification.publicRoutes.length +
          classification.roleGuarded.length +
          classification.permissionOnly.length +
          classification.unguarded.length
        }\n` +
        `\nlayer-2-only population: ${population.length} registered, ${seen.size} distinct signatures\n` +
        (duplicated.length === 0
          ? '  no duplicate signatures\n'
          : `  duplicated:\n${duplicated.map((l) => `    ${l}`).join('\n')}\n`),
    );

    // The four classes must partition the router exactly — no route counted twice or dropped.
    expect(
      classification.publicRoutes.length +
        classification.roleGuarded.length +
        classification.permissionOnly.length +
        classification.unguarded.length,
    ).toBe(routes.length);
    // §11 item 3 / TC-1's core property, re-asserted here because this suite recounts the router.
    expect(classification.unguarded).toEqual([]);
    // This suite's swept population IS the permission-only class, with nothing quietly filtered.
    expect(population.length).toBe(classification.permissionOnly.length);

    // The swept map must account for every distinct signature the router registers.
    expect(before.size).toBe(seen.size);
    // And the arithmetic must close: registered = distinct + collapsed.
    const collapsed = population.length - seen.size;
    expect(`registered=${population.length} distinct=${seen.size} collapsed=${collapsed}`).toBe(
      `registered=${population.length} distinct=${seen.size} collapsed=${population.length - seen.size}`,
    );
  });

  /**
   * The diff between the two sweeps, reported as the artefact it is.
   *
   * **Read this number carefully — it measures guard admission, not reachability.** Nest's order
   * is guards → interceptors → **pipes** → handler → service. Every probe here carries an empty
   * body, so a route that opens up reports `400` from `ValidationPipe`, which proves the two guard
   * layers passed and proves *nothing at all* about the service-layer `assertRole` sitting behind
   * the pipe. Distinguishing those two needs a request that survives validation, which is what the
   * next test does for the one route F-2 names.
   *
   * That distinction is not pedantry: it is the exact error the original F-2 made, and the first
   * draft of this very test made it again — it asserted `403` here, went red at `400`, and the
   * `400` was mistaken for a refutation-of-the-refutation until the pipe ordering was checked.
   */
  it('records which routes a maximally wrong table gets past the guard chain', () => {
    const opened = [...after.entries()]
      .filter(([signature, status]) => before.get(signature) === DENIED && status !== DENIED)
      .map(([signature, status]) => `${signature} 403 → ${status}`)
      .sort();

    const closed = [...after.entries()]
      .filter(([signature, status]) => before.get(signature) !== DENIED && status === DENIED)
      .map(([signature]) => signature)
      .sort();

    // Reported, not pinned to a hardcoded list: this is the audit's finding, and asserting a
    // fixed number would make it a change-detector for the very quantity it exists to discover.
    // eslint-disable-next-line no-console -- T-051: the diff IS the artefact this test produces.
    console.log(
      `\nF-2 measured — layer-2-only routes an over-granted merchant gets PAST THE GUARDS:\n` +
        (opened.length === 0 ? '  (none)\n' : `${opened.map((l) => `  ${l}`).join('\n')}\n`) +
        `  total: ${opened.length} of ${before.size} layer-2-only routes\n`,
    );

    // Over-granting must never *reduce* access — that would mean the write corrupted something.
    expect(closed).toEqual([]);

    // The guard chain must actually be table-driven on this population, or the experiment is
    // measuring nothing. If nothing opened, the grant silently failed to apply.
    expect(opened.length).toBeGreaterThan(0);
  });

  /**
   * **The decisive measurement, and the one the original F-2 never made.**
   *
   * A real, fully-valid `CreateCountryDto` from an over-granted `merchant`. This request survives
   * `ValidationPipe`, so it reaches the handler and therefore reaches
   * `CountriesService.create`'s opening `assertRole(actor, 'super_admin')` — the third layer,
   * which consults no table and no cache.
   *
   * Two outcomes, and the report says something different in each case:
   *
   *  - **403 and no row** → the delegation boundary survives a maximally wrong permission table.
   *    F-2's headline ("a single wrong row grants a merchant `POST /countries`") is false, and the
   *    §11 wording question is about decorators, not about a missing layer.
   *  - **201 and a row** → F-2 is a real privilege escalation and must be re-ranked upward.
   *
   * The row is checked in the database directly rather than inferred from the status, and deleted
   * in `afterAll` if it was created.
   */
  it('a valid POST /countries from an over-granted merchant is refused by the service layer', async () => {
    const code = await freeIsoCountryCode();
    probeCountryCode = code;

    const response = await http()
      .post('/api/v1/countries')
      .set('Cookie', merchant.jar)
      .set('X-CSRF-Token', merchant.csrf)
      .send({
        code,
        name: 'T-051 F-2 escalation probe',
        timezone: 'UTC',
        currencyCode: 'USD',
        dialingCode: '+999',
      });

    const rows = await sql<{ id: number }>(
      `SELECT id FROM reward_config.countries WHERE code = :code`,
      { code },
    );

    // Assert the *outcome in the database* first: it is the property that matters, and a status
    // code alone could be a 500 that still wrote a row.
    expect(`created rows for ${code}: ${rows.length}`).toBe(`created rows for ${code}: 0`);
    expect(response.status).toBe(DENIED);
    // The generic denial shape — a service-layer refusal must not be distinguishable from a
    // guard refusal, or it tells an attacker which layer stopped them.
    expect(response.body?.error?.code).toBe('PERM_DENIED');
  });

  it('the same service-layer floor holds for the other delegated write boundaries', async () => {
    // `POST /tenants` is `country_admin`-only in `TenantsService`; `POST /merchants` is
    // `tenant_admin`-only in `MerchantsService`. Both are layer-2-only routes, so if the table
    // were the only layer, an over-granted merchant would create rows here too.
    // Both bodies must be *valid*, or `ValidationPipe` answers 400 and the service layer is never
    // reached — the same trap the sweep above is careful to name. Note neither DTO carries a
    // scope id: `tenantId`/`countryId` come from the JWT (R3), so `forbidNonWhitelisted` rejects
    // a body that tries to supply one, which is itself worth knowing and cost a red run here.
    const tenant = await http()
      .post('/api/v1/tenants')
      .set('Cookie', merchant.jar)
      .set('X-CSRF-Token', merchant.csrf)
      .send({ code: 'T051F2_ESCALATE', name: 'T-051 F-2 escalation probe' });

    const merchantCreate = await http()
      .post('/api/v1/merchants')
      .set('Cookie', merchant.jar)
      .set('X-CSRF-Token', merchant.csrf)
      .send({
        merchantCode: 'T051F2_ESCALATE_M',
        name: 'T-051 F-2 escalation probe',
        countryCode: HOME_COUNTRY,
      });

    const tenantRows = await sql<{ id: number }>(
      `SELECT id FROM reward_config.tenants WHERE code = :code`,
      { code: 'T051F2_ESCALATE' },
    );
    const merchantRows = await sql<{ id: number }>(
      `SELECT id FROM reward_config.merchants WHERE merchant_code = :code`,
      { code: 'T051F2_ESCALATE_M' },
    );

    expect(`tenant rows: ${tenantRows.length}`).toBe('tenant rows: 0');
    expect(`merchant rows: ${merchantRows.length}`).toBe('merchant rows: 0');
    expect(tenant.status).toBe(DENIED);
    expect(merchantCreate.status).toBe(DENIED);
  });

  it('refuses to grant the six protected rule/reward cells to a non-super-admin at all', async () => {
    // The independent second layer for the six authoring cells is that the endpoint will not
    // write them — a 422 `PROTECTED_PERMISSION` raised in `AccessControlService`, not in the DTO.
    // Asserted here rather than assumed by `maximalGrantForNonSuperAdmin`'s filter.
    const current = await readPermissions('merchant');
    const response = await http()
      .put('/api/v1/admin/access-control/permissions/merchant')
      .set('Cookie', superAdmin.jar)
      .set('X-CSRF-Token', superAdmin.csrf)
      .send({
        expectedVersion: current.version,
        permissions: { ...current.permissions, rule: ['view', 'create'] },
      });

    expect(response.status).toBe(422);
    // And the table is unchanged by the rejected write.
    const unchanged = await readPermissions('merchant');
    expect(unchanged.permissions.rule ?? []).not.toContain('create');
  });

  it('restores the merchant matrix exactly, and the denials come back', async () => {
    await writePermissions('merchant', originalMerchantPermissions);
    granted = false;

    const restored = await readPermissions('merchant');
    expect(restored.permissions).toEqual(originalMerchantPermissions);

    store.clear();
    const recheck = new Map<string, number>();
    await sweep(recheck);
    expect([...recheck.entries()].sort()).toEqual([...before.entries()].sort());
  });
});

/**
 * The layer-2-only **mutating** routes that reach no role floor, each with the reason it is
 * acceptable — or, for the three `/users` writes, the reason it is not.
 *
 * This is the same device `route-inventory.e2e-spec.ts` uses for §15's public list: hold the
 * reviewed set as data, and fail the build when the running application disagrees with it. A new
 * mutating route with neither `@Roles` nor a service-layer floor cannot be added without landing
 * here first and being explained.
 *
 * **F-12 was fixed by T-088 (2026-08-23).** The three `/users` entries this map used to carry are
 * gone: `UsersService.update`/`deactivate`/`resetPassword` now open with
 * `assertManagementAllowed(actor.role, targetRole)`, the same `ALLOWED_CREATION` matrix
 * `assertCreationAllowed` already used for `create()`. The two `it.failing()` probes below have
 * been flipped to plain `it(...)` accordingly — see their own headers.
 */
const REVIEWED_UNFLOORED: Readonly<Record<string, string>> = Object.freeze({
  'POST /api/v1/notifications/:id/read':
    'Self-scoped, and correctly so: NotificationsService.markRead filters on `userId: actor.userId`, ' +
    'so the only row any role can touch is its own. A role floor would be meaningless here — every ' +
    'role legitimately reads its own notifications.',
  'POST /api/v1/notifications/read-all':
    'Same as above: the update is keyed on `actor.userId` and cannot reach another user’s row.',
});

describe('T-051 §11 item 2 — layer 1’s other expression, inventoried', () => {
  /**
   * The mechanical half of §11 item 2, and the test that found F-12.
   *
   * `route-inventory` proves no route lacks *authorisation metadata*. It cannot prove the stronger
   * thing item 2 actually asks for — that no endpoint lacks a **role** constraint — because 103
   * routes express that constraint in the service instead of in a decorator. This resolves those
   * routes to the service method behind them and asks the question directly.
   *
   * `unresolved` is asserted empty **before** the floors are compared, and on purpose: an analyser
   * that has lost its way would otherwise report its confusion as "no floor found" and turn a
   * parser regression into a fake security finding — or, worse, the reverse.
   */
  it('every layer-2-only mutating route reaches a role floor, or is a reviewed exception', () => {
    const resolutions = resolveRoleFloors(routes);
    const unresolved = resolutions.filter((entry) => entry.unresolved !== undefined);
    const unfloored = resolutions.filter(
      (entry) => entry.floor === undefined && entry.unresolved === undefined,
    );

    // eslint-disable-next-line no-console -- T-051: the inventory IS the artefact.
    console.log(
      `\n§11 item 2 — role floors behind the layer-2-only mutating routes:\n` +
        `  population        ${resolutions.length}\n` +
        `  floored in code   ${resolutions.length - unfloored.length - unresolved.length}\n` +
        `  no floor found    ${unfloored.length}\n` +
        `  unresolved        ${unresolved.length}\n` +
        (unfloored.length === 0
          ? ''
          : `\n${unfloored.map((entry) => `  NO FLOOR  ${entry.signature}`).join('\n')}\n`),
    );

    expect(unresolved.map((entry) => `${entry.signature}: ${entry.unresolved}`)).toEqual([]);
    // The population must be non-trivial, or an empty result would read as a clean bill of health.
    expect(resolutions.length).toBeGreaterThan(40);
    expect(unfloored.map((entry) => entry.signature).sort()).toEqual(
      Object.keys(REVIEWED_UNFLOORED).sort(),
    );
  });

  it('every reviewed exception carries a written reason', () => {
    for (const [signature, reason] of Object.entries(REVIEWED_UNFLOORED)) {
      expect(`${signature}: ${reason.length > 80}`).toBe(`${signature}: true`);
    }
  });
});

/**
 * # Fourth pass, 2026-08-23 — F-2 was refuted on `POST /countries`. Is it refuted *everywhere*?
 *
 * The third pass measured the delegated **creation** boundaries (`countries`, `tenants`,
 * `merchants`), found a service-layer `assertRole` behind each one, and downgraded F-2 to a
 * documentation note. It also wrote down, honestly, the limit of that result:
 *
 * > *"valid bodies were sent to three delegated writes, and the other 100 layer-2-only routes were
 * > checked by source inspection for a service-layer role floor, not by a valid-body probe. A route
 * > missing its `assertRole` would not have been caught."*
 *
 * This pass closed that gap mechanically first — `role-floor-inventory.ts` resolves every
 * layer-2-only **mutating** route to the service method its handler calls and asks whether that
 * method (or anything it delegates to) states a role floor. 47 of 55 do. Of the 8 that do not,
 * five are `/notifications` and `/approvals` routes that are floored elsewhere or are legitimately
 * self-scoped; **three are `/users` writes** — `PATCH /users/:id`, `POST /users/:id/deactivate`
 * and `POST /users/:id/reset-password`.
 *
 * That asymmetry is what made this worth probing rather than reasoning about: `POST /users`
 * (creation) *is* floored, by `assertCreationAllowed(actor.role, dto.role)` — a hardcoded matrix
 * that owes nothing to `role_entity_permissions`. So the design plainly did consider the role
 * question on this controller, and answered it for creation only. Resetting an existing user's
 * password is strictly the more powerful operation.
 *
 * ## Why a `maker` and not the `merchant` the suite already over-grants
 *
 * Layer 3 decides whether the target row is reachable at all, and `scope-strategy.ts` scopes
 * `PortalUser` differently per level:
 *
 * ```
 * country : column('countryId', 'country')
 * tenant  : column('tenantId',  'tenant')                       <- maker, checker, tenant_admin
 * merchant: every(column('tenantId'), column('merchantId'))     <- merchant
 * ```
 *
 * A `merchant` is bounded by `merchant_id` too, and a `tenant_admin` has none — so the merchant
 * fixture cannot reach a tenant_admin row no matter what the permission table says, and probing
 * with it would return a reassuring 404 that proves nothing about layer 1. A **`maker`** is scoped
 * by `tenant_id` alone and shares that tenant with its own `tenant_admin`. If layer 1 is absent
 * here, the maker is the role that can prove it.
 *
 * ## What is asserted, and why it is a database fact and not a status code
 *
 * The status code cannot distinguish "refused" from "failed noisily after writing". So the
 * assertions lead with the victim's stored `password_hash` and `must_change_password`, read back
 * as they are on disk, and the status is checked second. 02-SECURITY.md §5's promise is the
 * property under test: *"Layers are independent on purpose: a mistake in one must not become an
 * exploit."* One wrong row in `role_entity_permissions` is exactly one mistake in one layer.
 */
describe('T-051 F-2, second population — the `/users` writes', () => {
  /** The victim's stored credential exactly as it was before the probe. */
  let victimHashBefore: string;

  async function credentialOf(
    userId: number,
  ): Promise<{ hash: string; mustChange: boolean } | undefined> {
    const [row] = await sql<{ password_hash: string; must_change_password: boolean }>(
      `SELECT c.password_hash, u.must_change_password
         FROM reward_portal.portal_user_credentials c
         JOIN reward_portal.portal_users u ON u.id = c.user_id
        WHERE c.user_id = :userId`,
      { userId },
    );
    if (row === undefined) return undefined;
    return { hash: row.password_hash, mustChange: row.must_change_password };
  }

  beforeAll(async () => {
    const captured = await readPermissions('maker');
    originalMakerPermissions = captured.permissions;

    // The same "never start from a contaminated baseline" guard the merchant half uses. If a
    // previous killed run left the maker holding `user:update`, capturing it as "the original"
    // would restore the contamination and quietly weaken the live system.
    expect(originalMakerPermissions.user ?? []).not.toContain('update');

    const credential = await credentialOf(tenantAdmin.userId);
    if (credential === undefined) throw new Error('tenant_admin fixture has no credential row');
    victimHashBefore = credential.hash;
    expect(credential.mustChange).toBe(false);

    await writePermissions('maker', maximalGrantForNonSuperAdmin());
    makerGranted = true;
    store.clear();
  });

  afterAll(async () => {
    if (makerGranted && originalMakerPermissions !== undefined) {
      await writePermissions('maker', originalMakerPermissions);
      makerGranted = false;

      const restored = await readPermissions('maker');
      expect(restored.permissions).toEqual(originalMakerPermissions);
    }
  });

  it('the over-grant landed, so a null result cannot be a silent no-op', async () => {
    const readBack = await readPermissions('maker');
    expect(readBack.permissions.user ?? []).toContain('update');
  });

  /**
   * Establishes that layer 3 is **not** the thing standing between these two roles, so that a
   * refusal below can only have come from layer 1 and a success below cannot be dismissed as
   * "the row was out of scope anyway". Without this, both outcomes are ambiguous.
   */
  it('layer 3 does not separate a maker from its own tenant_admin', async () => {
    const response = await http()
      .get(`/api/v1/users/${tenantAdmin.userId}`)
      .set('Cookie', maker.jar);

    expect(`GET /users/${tenantAdmin.userId} as maker → ${response.status}`).toBe(
      `GET /users/${tenantAdmin.userId} as maker → 200`,
    );
    expect(response.body?.data?.id).toBe(tenantAdmin.userId);
  });

  /**
   * ## Flipped from `it.failing()` by T-088 (2026-08-23) — F-12 is fixed
   *
   * This was registered `it.failing()` while the defect stood, the same construct F-4 (the
   * broken account lockout) used in `login-enumeration.e2e-spec.ts` until T-082 landed: the test
   * passed *because* its assertions failed, and was designed to turn red the moment the defect
   * was fixed, forcing exactly this flip back to a plain `it(...)`.
   * `UsersService.resetPassword` now opens with `assertManagementAllowed(actor.role,
   * user.role)` — the same `ALLOWED_CREATION` matrix `create()` already enforced — so the request
   * below is refused before `CredentialService.changePassword()` is ever called.
   *
   * The exploit evidence is still `console.log`ged rather than folded into a single assertion,
   * so a future regression is easy to read at a glance rather than only "some expect failed".
   */
  it('an over-granted maker cannot reset its tenant_admin’s password', async () => {
    const response = await http()
      .post(`/api/v1/users/${tenantAdmin.userId}/reset-password`)
      .set('Cookie', maker.jar)
      .set('X-CSRF-Token', maker.csrf)
      .send({});

    const after = await credentialOf(tenantAdmin.userId);
    const disclosed = response.body?.data?.temporaryPassword ?? response.body?.data?.password;

    // Does the value handed back actually authenticate as the victim? That is the difference
    // between "an attacker disrupted an account" and "an attacker owns it", and it cannot be
    // inferred from a status code. Recorded, never asserted — see the header.
    let takeover = 'not attempted (no password in the response body)';
    if (typeof disclosed === 'string' && disclosed.length > 0) {
      store.clear();
      const asVictim = await loginCompletingMfa(
        app,
        { email: tenantAdmin.email, password: disclosed },
        db,
      );
      takeover = `login as the tenant_admin with the disclosed password → ${asVictim.status}`;
    }

    // eslint-disable-next-line no-console -- T-051 F-12: the measurement IS the finding.
    console.log(
      `\nF-12 measured — maker holding a wrongly-granted user:update, against its own tenant_admin:\n` +
        `  POST /users/${tenantAdmin.userId}/reset-password → ${response.status}\n` +
        `  response data keys: ${
          Object.keys(response.body?.data ?? {})
            .sort()
            .join(', ') || '(none)'
        }\n` +
        `  victim credential hash changed: ${after?.hash !== victimHashBefore}\n` +
        `  victim mustChangePassword now:  ${after?.mustChange}\n` +
        `  ${takeover}\n`,
    );

    // The database first: this is the property, and it is true or false regardless of the status.
    expect(`victim credential changed: ${after?.hash !== victimHashBefore}`).toBe(
      'victim credential changed: false',
    );
    expect(`victim mustChangePassword: ${after?.mustChange}`).toBe(
      'victim mustChangePassword: false',
    );
    // Then the status, and the body shape — a 200 here hands the caller a usable password.
    expect(
      `status=${response.status} bodyKeys=${Object.keys(response.body?.data ?? {})
        .sort()
        .join(',')}`,
    ).toBe('status=403 bodyKeys=');
  });

  /** Same flip, same reason, the other two `/users` writes F-12 named. See the previous test. */
  it('an over-granted maker cannot deactivate or rename its tenant_admin', async () => {
    const deactivate = await http()
      .post(`/api/v1/users/${tenantAdmin.userId}/deactivate`)
      .set('Cookie', maker.jar)
      .set('X-CSRF-Token', maker.csrf)
      .send({});

    const rename = await http()
      .patch(`/api/v1/users/${tenantAdmin.userId}`)
      .set('Cookie', maker.jar)
      .set('X-CSRF-Token', maker.csrf)
      .send({ displayName: 'T-051 fourth-pass escalation probe' });

    const [row] = await sql<{ status: string; display_name: string }>(
      `SELECT status, display_name FROM reward_portal.portal_users WHERE id = :id`,
      { id: tenantAdmin.userId },
    );

    // eslint-disable-next-line no-console -- T-051 F-12: the measurement IS the finding.
    console.log(
      `\nF-12 measured — the other two unfloored /users writes:\n` +
        `  POST /users/:id/deactivate → ${deactivate.status}\n` +
        `  PATCH /users/:id           → ${rename.status}\n` +
        `  victim row now: status=${row?.status} displayName=${row?.display_name}\n`,
    );

    expect(`status=${row?.status} displayName=${row?.display_name}`).toBe(
      `status=active displayName=T-051 F-2 tenant_admin`,
    );
    expect(`deactivate=${deactivate.status} rename=${rename.status}`).toBe(
      'deactivate=403 rename=403',
    );
  });

  /**
   * ## The positive control — added on the fifth pass, 2026-08-23
   *
   * The two tests above are, on their own, **not sufficient evidence that F-12 is fixed.** They
   * assert that three writes are refused; a `UsersService` whose three methods had been deleted,
   * or whose new floor refused *every* actor, would satisfy them exactly. This is the same hole
   * this report caught in its own first probe of F-3, where three "permission denied" results
   * would have been produced equally by a correct `REVOKE` and by a role that had lost all access
   * to the table — and it was closed there by adding a `SELECT` that must still succeed.
   *
   * The equivalent here is a *legitimate* delegation over the same three routes:
   * `tenant_admin` → its own `maker` is adjacent in `ALLOWED_CREATION`, and `tenant_admin`
   * genuinely holds `user:update` in the **shipped** `role_entity_permissions` (unlike the maker
   * above, which had to be over-granted to get this far). So this is the everyday path the
   * feature exists for, and it must still work.
   *
   * It asserts the strongest available form of "still works": not the status code, but that the
   * password handed back **actually authenticates as the target**. A 201 carrying a temporary
   * password that does not work would be a broken feature reported as a working one — the exact
   * inverse of the takeover this suite measured on the fourth pass, and equally invisible to a
   * status-only assertion.
   *
   * Ordering matters and is deliberate: rename, then reset-password (which needs the account
   * live to prove the login), then deactivate last, because deactivation revokes sessions and
   * ends the maker's usefulness as a fixture. Nothing runs after this test in the file.
   */
  it('the same three writes still work for a legitimately delegated tenant_admin', async () => {
    const makerHashBefore = (await credentialOf(maker.userId))?.hash;

    const rename = await http()
      .patch(`/api/v1/users/${maker.userId}`)
      .set('Cookie', tenantAdmin.jar)
      .set('X-CSRF-Token', tenantAdmin.csrf)
      .send({ displayName: 'T-051 fifth-pass positive control' });

    store.clear();
    const reset = await http()
      .post(`/api/v1/users/${maker.userId}/reset-password`)
      .set('Cookie', tenantAdmin.jar)
      .set('X-CSRF-Token', tenantAdmin.csrf)
      .send({});

    const disclosed: unknown = reset.body?.data?.temporaryPassword;
    const makerAfterReset = await credentialOf(maker.userId);

    // The control's load-bearing assertion: the credential the API issued is usable. A status
    // code cannot distinguish "reset succeeded" from "responded 201 and changed nothing usable".
    let loginStatus = 'not attempted (no password in the response body)';
    if (typeof disclosed === 'string' && disclosed.length > 0) {
      store.clear();
      const asMaker = await loginCompletingMfa(
        app,
        { email: maker.email, password: disclosed },
        db,
      );
      loginStatus = `login as the maker with the issued password → ${asMaker.status}`;
    }

    const deactivate = await http()
      .post(`/api/v1/users/${maker.userId}/deactivate`)
      .set('Cookie', tenantAdmin.jar)
      .set('X-CSRF-Token', tenantAdmin.csrf)
      .send({});

    const [row] = await sql<{ status: string; display_name: string }>(
      `SELECT status, display_name FROM reward_portal.portal_users WHERE id = :id`,
      { id: maker.userId },
    );

    // eslint-disable-next-line no-console -- T-051: the control is as much the artefact as the probe.
    console.log(
      `\nF-12 positive control — tenant_admin acting on its own maker (a legitimate delegation):\n` +
        `  PATCH /users/${maker.userId}                → ${rename.status}\n` +
        `  POST  /users/${maker.userId}/reset-password → ${reset.status}\n` +
        `  maker credential hash changed: ${makerAfterReset?.hash !== makerHashBefore}\n` +
        `  ${loginStatus}\n` +
        `  POST  /users/${maker.userId}/deactivate     → ${deactivate.status}\n` +
        `  maker row now: status=${row?.status} displayName=${row?.display_name}\n`,
    );

    expect(`rename=${rename.status} reset=${reset.status} deactivate=${deactivate.status}`).toBe(
      'rename=200 reset=201 deactivate=201',
    );
    expect(loginStatus).toBe('login as the maker with the issued password → 200');
    expect(`credential changed: ${makerAfterReset?.hash !== makerHashBefore}`).toBe(
      'credential changed: true',
    );
    expect(`status=${row?.status} displayName=${row?.display_name}`).toBe(
      'status=inactive displayName=T-051 fifth-pass positive control',
    );
  });

  /**
   * ## The other edge of T-088's floor — finding F-13, fifth pass 2026-08-23
   *
   * The floor T-088 chose is `ALLOWED_CREATION`, the *creation* matrix, which is deliberately
   * one level deep: `super_admin → [country_admin]`, `country_admin → [tenant_admin]`,
   * `tenant_admin → [maker, checker, merchant]`. Reused as a *management* floor, that means an
   * actor may only act on a user it could itself have created — so a `super_admin` can no longer
   * rename, deactivate or reset-password anything but a `country_admin`.
   *
   * That is a coherent policy and it is exactly what closed F-12. It is recorded here because it
   * is **not** the policy the rest of the built system assumes: `portal/e2e/specs/
   * negative-journeys.spec.ts` TC-N9 — a shipped test of a `done` task (T-050) — deactivates an
   * `isolatedScenario.checker` through `superAdminApi`, which is now `403
   * ROLE_MANAGEMENT_NOT_PERMITTED`. Neither 03-API-CONTRACT.md §7 (which specifies the creation
   * matrix and says only "scope-checked" for `PATCH`/`deactivate`) nor T-035's own task file
   * states a role floor for these three routes, so this is a gap being filled, not a documented
   * rule being applied — and which way it should be filled is the owning task's call, not this
   * audit's.
   *
   * **This test asserts the policy as built, not the policy this audit prefers.** The device is
   * the one `REVIEWED_UNFLOORED` and §15's public list already use here: hold the reviewed answer
   * as data and fail the build when the running system disagrees. If T-088's matrix is widened,
   * these cells go red and force this table — and the review that goes with it — to be updated,
   * which is the point. Asserting nothing would let the policy drift silently in either direction.
   *
   * `deactivate` is probed against the maker the positive control above has already deactivated,
   * so a hypothetical *admission* here writes nothing new; the floor is evaluated immediately
   * after the target row is fetched, before any status logic, so a refusal is measured either way.
   */
  it('a super_admin can act on a country_admin only — F-13, recorded as built', async () => {
    const renameTenantAdmin = await http()
      .patch(`/api/v1/users/${tenantAdmin.userId}`)
      .set('Cookie', superAdmin.jar)
      .set('X-CSRF-Token', superAdmin.csrf)
      .send({ displayName: 'T-051 F-13 probe' });

    const renameMaker = await http()
      .patch(`/api/v1/users/${maker.userId}`)
      .set('Cookie', superAdmin.jar)
      .set('X-CSRF-Token', superAdmin.csrf)
      .send({ displayName: 'T-051 F-13 probe' });

    const deactivateMaker = await http()
      .post(`/api/v1/users/${maker.userId}/deactivate`)
      .set('Cookie', superAdmin.jar)
      .set('X-CSRF-Token', superAdmin.csrf)
      .send({});

    const codeOf = (response: request.Response): string =>
      String(response.body?.error?.code ?? '(none)');

    // eslint-disable-next-line no-console -- T-051 F-13: the measurement IS the finding.
    console.log(
      `\nF-13 measured — what a super_admin may do to a user it did not create:\n` +
        `  PATCH  /users/:id  (tenant_admin) → ${renameTenantAdmin.status} ${codeOf(renameTenantAdmin)}\n` +
        `  PATCH  /users/:id  (maker)        → ${renameMaker.status} ${codeOf(renameMaker)}\n` +
        `  POST   /users/:id/deactivate      → ${deactivateMaker.status} ${codeOf(deactivateMaker)}\n` +
        `  (T-050 negative-journeys TC-N9 performs the third of these against a checker)\n`,
    );

    expect(
      `rename(tenant_admin)=${renameTenantAdmin.status}:${codeOf(renameTenantAdmin)} ` +
        `rename(maker)=${renameMaker.status}:${codeOf(renameMaker)} ` +
        `deactivate(maker)=${deactivateMaker.status}:${codeOf(deactivateMaker)}`,
    ).toBe(
      'rename(tenant_admin)=403:ROLE_MANAGEMENT_NOT_PERMITTED ' +
        'rename(maker)=403:ROLE_MANAGEMENT_NOT_PERMITTED ' +
        'deactivate(maker)=403:ROLE_MANAGEMENT_NOT_PERMITTED',
    );
  });
});
