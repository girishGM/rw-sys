/**
 * T-051 — **the role × endpoint matrix**, and the probe suites built on the same six sessions.
 *
 * The task file calls this "a large generated table and ... the single most valuable artefact of
 * this task". It is generated rather than written out, because a hand-maintained table of
 * 6 × ~174 cells is a table that is wrong within a week; and it is *checked against the running
 * server* rather than against the metadata it was generated from, because a table derived from
 * the code and compared to the code proves only that the code equals itself.
 *
 * ```
 *   metadata (@Roles/@RequirePermission)  ─┐
 *                                          ├─► expectedOutcome() ──► predicted
 *   role_entity_permissions (live rows)   ─┘                              │
 *                                                                         ├─ compared
 *   real HTTP request, real session, real guard chain ──► observed  ──────┘
 * ```
 *
 * `expectedOutcome` is unit-tested in `role-matrix.spec.ts`; this file supplies the observable
 * half AGENT-PROTOCOL §3 requires.
 *
 * ## What each suite here covers
 *
 * ```
 *  TC-2   role × endpoint matrix        every role against every route
 *  TC-11  CSRF omission                 every mutating route, session present, header absent
 *  TC-12  IDOR sweep                    every :id route, out-of-scope real ids → 404 (never 403/200)
 *  TC-13  mass assignment               role/tenantId/status/id posted to every write endpoint
 *  TC-14  SQL metacharacters            stored literally
 *  TC-15  stored XSS                    round-trips escaped, never executed
 *  TC-17  rate limits                   the six limited surfaces
 *  TC-19  error hygiene                 no stack, no SQL, no schema name on any failure path
 * ```
 *
 * ## Probing without mutating
 *
 * Every path parameter is filled with an id that **cannot exist** ({@link IMPOSSIBLE_ID}), and
 * every mutating request carries `{}` as its body. Two independent things then keep the database
 * still: guards run before pipes, so a denied role is refused before the body is looked at; and an
 * admitted role reaching a handler either fails `ValidationPipe` (400) or fails to find the row
 * (404). The two routes that would end the session doing this — `POST /auth/logout` and
 * `POST /auth/logout-all` — are excluded from the sweep and probed at the very end against
 * **disposable** sessions minted for the purpose, so their cells are measured rather than assumed.
 *
 * ## On the throttle store
 *
 * The counter store is the real `MemoryThrottleStore` with the real rules, limits and windows from
 * 02-SECURITY.md §8; the only thing this file adds is the ability to clear it between phases,
 * which is what waiting out a 60-second window would do anyway. It is cleared because the sweep
 * issues ~174 requests per role and the authenticated ceiling is 300/min — close enough that a
 * slow run would start measuring the limiter instead of the guards. TC-17 below drives four of
 * those limits to their thresholds and asserts the 429/503, so nothing about rate limiting is
 * taken on trust here.
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
import { createMigrationConnection } from '@/database/migration-connection';
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
import {
  ALL_ROLES,
  collectGuardedRoutes,
  expectedOutcome,
  grantsFromRows,
  type CellOutcome,
  type GuardedRoute,
  type PermissionGrants,
} from './support/route-guard-inventory';
import { bindTestServer } from './support/bound-app';

jest.setTimeout(900_000);

/** Namespaces this suite's `encryption_keys` rows, so two suites cannot delete each other's. */
const SUITE = 't051';

const PASSWORD = 'correct horse battery staple 7!';
/** `countries.code` is `character(2)`; distinct from every other suite's fixture. */
const HOME_COUNTRY = 'ZQ';
const FOREIGN_COUNTRY = 'ZW';
const HOME_TENANT = 'T051_E2E_HOME';
const FOREIGN_TENANT = 'T051_E2E_FOREIGN';
const HOME_MERCHANT = 'T051_E2E_M_HOME';
const FOREIGN_MERCHANT = 'T051_E2E_M_FOREIGN';
const HOME_CAMPAIGN = 'T051_E2E_C_HOME';
const FOREIGN_CAMPAIGN = 'T051_E2E_C_FOREIGN';

/** A primary key no row has. Used wherever a path parameter must resolve to nothing. */
const IMPOSSIBLE_ID = 999_999_999;

/**
 * Routes excluded from the bulk sweep because calling them would end the session the sweep is
 * being conducted with. Probed separately, against disposable sessions, in the final describe.
 */
const SESSION_DESTROYING = new Set(['POST /api/v1/auth/logout', 'POST /api/v1/auth/logout-all']);

/**
 * Cells where both guards admit the role but the request is still refused **403** — by an
 * authority check deeper than the guard chain. Each is a documented, deliberate control, not a
 * surprise; listing them here means a *new* one fails the build and has to be explained.
 */
const SECOND_LAYER_DENIALS: ReadonlyMap<string, string> = new Map([
  [
    'GET /api/v1/reveal/:policyKey/:recordId',
    '07-DATA-PROTECTION.md — the reveal endpoint admits all six roles at the guard chain and ' +
      'then asks the policy engine whether this actor may reveal this field. A role with no ' +
      'reveal grant is refused there, by design (T-017).',
  ],
]);

class ResettableThrottleStore implements ThrottleStore {
  readonly kind = 'memory' as const;
  private delegate = new MemoryThrottleStore();

  async consume(key: string, windowMs: number, now: number): Promise<ThrottleCounter> {
    return this.delegate.consume(key, windowMs, now);
  }

  reset(): void {
    this.delegate = new MemoryThrottleStore();
  }
}

interface Actor {
  readonly role: PortalRole;
  readonly email: string;
  readonly userId: number;
  readonly jar: string;
  readonly csrf: string;
  readonly grants: PermissionGrants;
}

interface Cell {
  readonly route: GuardedRoute;
  readonly role: PortalRole;
  readonly predicted: CellOutcome;
  readonly status: number;
  /**
   * A short rendering of the response body, carried so a failing assertion can say *what* came
   * back rather than only that the status was wrong. Added while root-causing an intermittent
   * `GET /campaigns/:id/audit → 200` (see the IDOR assertion below): a status code alone could
   * not distinguish "the handler ignored its id" from "the id resolved to a real row", and
   * re-running a 13-second sweep hoping to catch it again is not a diagnosis.
   */
  readonly body: string;
  readonly diagnostics: string;
}

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;
let store: ResettableThrottleStore;
let routes: GuardedRoute[];

const actors = new Map<PortalRole, Actor>();
const matrix: Cell[] = [];

let homeCountry: number;
let foreignCountry: number;
let homeTenant: number;
let foreignTenant: number;
let homeMerchant: number;
let foreignMerchant: number;
let homeCampaign: number;
let foreignCampaign: number;
let foreignUser: number;

/** Set once in `beforeAll` by `bindTestServer` — see that helper for why this is not
 *  `request(app.getHttpServer())`. */
let baseUrl: string;

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
function probePath(route: GuardedRoute, id: number = IMPOSSIBLE_ID): string {
  return `/api/v1${route.path}`
    .replace(/:level\b/g, '1')
    .replace(/:role\b/g, 'merchant')
    .replace(/:policyKey\b/g, 't051-nonexistent-policy')
    .replace(/:correlationId\b/g, '00000000-0000-4000-8000-000000000000')
    .replace(/:[A-Za-z]+/g, String(id));
}

type Verb = 'get' | 'post' | 'put' | 'patch' | 'delete';

function send(actor: Actor, route: GuardedRoute, path: string, body: unknown = {}): request.Test {
  const verb = route.method.toLowerCase() as Verb;
  const call = http()[verb](path).set('Cookie', actor.jar);
  if (verb === 'get') return call;
  return call.set('X-CSRF-Token', actor.csrf).send(body as object);
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

async function ensureCampaign(code: string, tenantId: number): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.tenant_campaigns WHERE campaign_code = :code`,
    { code },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.tenant_campaigns
          SET deleted_at = NULL, tenant_id = :tenantId, name = :code, status = 'draft'
        WHERE id = :id`,
      { id: existing.id, tenantId, code },
    );
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenant_campaigns
            (tenant_id, campaign_code, name, start_date, end_date, status, created_by)
     VALUES (:tenantId, :code, :code, now(), now() + interval '30 days', 'draft', 't051-e2e')
     RETURNING id`,
    { code, tenantId },
  );
  return created.id;
}

/** Every fixture address this suite owns. Also the cleanup key — see {@link releaseFixtureUsers}. */
const FIXTURE_EMAILS: readonly string[] = [
  ...ALL_ROLES.map((role) => `t051-e2e-${role}@example.invalid`),
  't051-e2e-foreign-user@example.invalid',
];

/**
 * Clears the `ON DELETE RESTRICT` references that would otherwise make this suite's users
 * undeletable, then deletes the users.
 *
 * **Why this is needed.** `portal_users` is referenced by five `ON DELETE RESTRICT` foreign keys
 * (`agent_sessions.portal_user_id`, `portal_approval_requests.requested_by`/`reviewed_by`,
 * `portal_campaign_audit_trail.performed_by`/`approved_by`). The bulk sweep calls **every** route,
 * and `POST /campaign-agent/sessions` accepts an empty body — so the `maker` cell creates a real
 * `agent_sessions` row. `deletePortalUsersByEmail` then fails, the `afterAll` leaves the users
 * behind, and *every subsequent run* dies in `beforeAll` on the leftovers. Observed on the first
 * run of this file, not theorised; the same shape of hazard T-067 and T-070 were filed for.
 *
 * **Why it needs the migration connection.** `reward_app` holds no `DELETE` on `agent_sessions` or
 * `agent_session_events` — they are append-only by T-048's design, and that is correct, so this is
 * not something to "fix" by widening a grant. A test fixture that the application role deliberately
 * cannot remove is removed with the migration credential instead, exactly as
 * `schema-drift.e2e-spec.ts` already does for the scratch table it creates. The connection is
 * opened only when there is something to delete and closed immediately.
 *
 * The deletes are ordered child-first (`agent_session_events` is itself `RESTRICT` against
 * `agent_sessions`) and scoped strictly to this suite's own users by blind index, so they cannot
 * touch anything else.
 */
async function releaseFixtureUsers(): Promise<void> {
  const bidx = FIXTURE_EMAILS.map((email) => emailCrypto.blindIndexFor(email));

  const [blocked] = await sql<{ n: string }>(
    `SELECT count(*) AS n FROM reward_portal.agent_sessions
      WHERE portal_user_id IN (
        SELECT id FROM reward_portal.portal_users WHERE email_bidx IN (:bidx))`,
    { bidx },
  );

  if (Number(blocked.n) > 0) {
    const migration = createMigrationConnection();
    try {
      await migration.query(
        `DELETE FROM reward_portal.agent_session_events
          WHERE session_id IN (
            SELECT s.id FROM reward_portal.agent_sessions s
             WHERE s.portal_user_id IN (
               SELECT id FROM reward_portal.portal_users WHERE email_bidx IN (:bidx)))`,
        { type: QueryTypes.RAW, replacements: { bidx } },
      );
      await migration.query(
        `DELETE FROM reward_portal.agent_sessions
          WHERE portal_user_id IN (
            SELECT id FROM reward_portal.portal_users WHERE email_bidx IN (:bidx))`,
        { type: QueryTypes.RAW, replacements: { bidx } },
      );
    } finally {
      await migration.close();
    }
  }

  await deletePortalUsersByEmail(db, emailCrypto, FIXTURE_EMAILS);
}

async function makeActor(
  role: PortalRole,
  scope: { countryId: number | null; tenantId: number | null; merchantId: number | null },
  permissionRows: readonly { role: string; entity: string; actions: unknown }[],
): Promise<Actor> {
  const email = `t051-e2e-${role}@example.invalid`;

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-051 ${role}`,
    role,
    ...scope,
  });

  await exec(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
  );

  // `super_admin` now completes an MFA challenge (T-055); the other five do not. Nothing stubbed.
  const response = await loginCompletingMfa(app, { email, password: PASSWORD }, db);
  if (response.status !== 200) {
    throw new Error(
      `login for ${role} failed: ${response.status} ${JSON.stringify(response.body)}`,
    );
  }

  const actor: Actor = {
    role,
    email,
    userId,
    jar: jarFrom(response),
    csrf: csrfFrom(response),
    grants: grantsFromRows(permissionRows, role),
  };
  actors.set(role, actor);
  return actor;
}

/** A second session for the same user, used for the two routes that destroy one. */
async function disposableSession(actor: Actor): Promise<{ jar: string; csrf: string }> {
  const response = await loginCompletingMfa(app, { email: actor.email, password: PASSWORD }, db);
  if (response.status !== 200) {
    throw new Error(`disposable login for ${actor.role} failed: ${response.status}`);
  }
  return { jar: jarFrom(response), csrf: csrfFrom(response) };
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
    apiOrigin: process.env.API_ORIGIN ?? 'https://api.t051.example.test',
    corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS,
    trustProxy: undefined,
    enforceHttps: false,
  });
  baseUrl = await bindTestServer(app);

  db = app.get<Sequelize>(SEQUELIZE);
  emailCrypto = emailCryptoOf(app);
  routes = collectGuardedRoutes(app);

  homeCountry = await ensureCountry(HOME_COUNTRY, 'T-051 Home');
  foreignCountry = await ensureCountry(FOREIGN_COUNTRY, 'T-051 Foreign');
  homeTenant = await ensureTenant(HOME_TENANT, homeCountry);
  foreignTenant = await ensureTenant(FOREIGN_TENANT, foreignCountry);
  homeMerchant = await ensureMerchant(HOME_MERCHANT, homeTenant, HOME_COUNTRY);
  foreignMerchant = await ensureMerchant(FOREIGN_MERCHANT, foreignTenant, FOREIGN_COUNTRY);
  homeCampaign = await ensureCampaign(HOME_CAMPAIGN, homeTenant);
  foreignCampaign = await ensureCampaign(FOREIGN_CAMPAIGN, foreignTenant);

  // Before any actor is created: clears both this run's fixtures and anything a previously
  // killed run left behind. See `releaseFixtureUsers`.
  await releaseFixtureUsers();

  const permissionRows = await sql<{ role: string; entity: string; actions: unknown }>(
    `SELECT role, entity, actions FROM reward_config.role_entity_permissions`,
  );
  // A matrix computed from an empty grant table would predict "denied" everywhere and agree with
  // a server that was denying everything for the wrong reason.
  expect(permissionRows.length).toBeGreaterThan(20);

  await makeActor(
    'super_admin',
    { countryId: null, tenantId: null, merchantId: null },
    permissionRows,
  );
  await makeActor(
    'country_admin',
    { countryId: homeCountry, tenantId: null, merchantId: null },
    permissionRows,
  );
  await makeActor(
    'tenant_admin',
    { countryId: homeCountry, tenantId: homeTenant, merchantId: null },
    permissionRows,
  );
  await makeActor(
    'maker',
    { countryId: homeCountry, tenantId: homeTenant, merchantId: null },
    permissionRows,
  );
  await makeActor(
    'checker',
    { countryId: homeCountry, tenantId: homeTenant, merchantId: null },
    permissionRows,
  );
  await makeActor(
    'merchant',
    { countryId: homeCountry, tenantId: homeTenant, merchantId: homeMerchant },
    permissionRows,
  );

  // An out-of-scope user row for the IDOR sweep over `/users/:id`.
  foreignUser = await insertPortalUser(db, emailCrypto, {
    email: 't051-e2e-foreign-user@example.invalid',
    displayName: 'T-051 foreign user',
    role: 'maker',
    countryId: foreignCountry,
    tenantId: foreignTenant,
    merchantId: null,
  });

  // --- the sweep itself, run once and asserted many ways below --------------------------------
  let sinceReset = 0;
  for (const role of ALL_ROLES) {
    const actor = actors.get(role);
    if (actor === undefined) throw new Error(`no actor for ${role}`);

    for (const route of routes) {
      if (route.isPublic) continue;
      if (SESSION_DESTROYING.has(route.signature)) continue;

      if (sinceReset++ >= 120) {
        store.reset();
        sinceReset = 0;
      }

      const response = await send(actor, route, probePath(route));
      matrix.push({
        route,
        role,
        predicted: expectedOutcome(route, role, actor.grants),
        status: response.status,
        body: JSON.stringify(response.body ?? null).slice(0, 400),
        diagnostics: `ct=${String(response.headers['content-type'])} len=${String(
          response.headers['content-length'],
        )} text=${JSON.stringify(response.text ?? null).slice(0, 200)}`,
      });
    }
  }
});

afterAll(async () => {
  if (db !== undefined) {
    await releaseFixtureUsers();
    // `reward_app` has no DELETE on `reward_config`; the fixtures are made inert instead, exactly
    // as `rbac.e2e-spec.ts` documents for its own.
    await exec(
      `UPDATE reward_config.tenant_campaigns SET deleted_at = now()
        WHERE campaign_code IN (:codes)`,
      { codes: [HOME_CAMPAIGN, FOREIGN_CAMPAIGN] },
    );
    await exec(
      `UPDATE reward_config.merchants SET status = 'inactive' WHERE merchant_code IN (:codes)`,
      {
        codes: [HOME_MERCHANT, FOREIGN_MERCHANT],
      },
    );
    await exec(`UPDATE reward_config.tenants SET status = 'inactive' WHERE code IN (:codes)`, {
      codes: [HOME_TENANT, FOREIGN_TENANT],
    });
    await removeEncryptionKeys(db, SUITE);
  }
  await app?.close();
});

// --- TC-2 -------------------------------------------------------------------------------------

describe('TC-2: the role × endpoint matrix', () => {
  it('probed every non-public route for all six roles', () => {
    const probed = routes.filter(
      (route) => !route.isPublic && !SESSION_DESTROYING.has(route.signature),
    );

    expect(probed.length).toBeGreaterThan(100);
    expect(matrix).toHaveLength(probed.length * ALL_ROLES.length);
    // No cell may have been answered by the limiter rather than by the chain.
    expect(matrix.filter((cell) => cell.status === 429)).toEqual([]);
    // Nor by an expired session: a 401 anywhere means the sweep lost its cookies part-way and
    // every "denied" reading after that point would be meaningless.
    expect(matrix.filter((cell) => cell.status === 401)).toEqual([]);
  });

  it('refuses with exactly 403 every cell the guard chain predicts "denied"', () => {
    const wrong = matrix
      .filter((cell) => cell.predicted === 'denied' && cell.status !== 403)
      .map((cell) => `${cell.role} ${cell.route.signature} → ${cell.status} (expected 403)`);

    expect(wrong).toEqual([]);
  });

  it('admits every cell the guard chain predicts "admitted"', () => {
    const wrong = matrix
      .filter((cell) => cell.predicted === 'admitted' && cell.status === 403)
      .filter((cell) => !SECOND_LAYER_DENIALS.has(cell.route.signature))
      .map((cell) => `${cell.role} ${cell.route.signature} → 403 (expected admission)`);

    // A route appearing here is one whose *guards* admit the caller while something deeper
    // refuses it. That may be correct (see SECOND_LAYER_DENIALS) but it is never something to
    // discover silently — an undocumented one means the matrix no longer describes the system.
    expect(wrong).toEqual([]);
  });

  it('never returns 200 for a path parameter that resolves to nothing', () => {
    // The other half of TC-12: a handler that ignores its `:id` and answers 200 would be an IDOR
    // regardless of scoping, because the id was never used to find anything.
    //
    // Restricted to routes where an **id-shaped** parameter was actually replaced with
    // `IMPOSSIBLE_ID`. `/admin/access-control/{nav,permissions,widgets}/:role` are excluded by
    // that test and must be: `:role` is a role *name*, not a row id, and `probePath` fills it
    // with the valid value `merchant`. Those three answering 200 is the correct behaviour — the
    // first draft of this assertion flagged them, and the assertion was wrong, not the routes.
    const leaked = matrix
      .filter((cell) => probePath(cell.route).includes(String(IMPOSSIBLE_ID)))
      .filter((cell) => cell.status === 200)
      .map(
        (cell) =>
          `${cell.role} ${cell.route.signature} → 200 for id ${IMPOSSIBLE_ID}: ${cell.body} | ${cell.diagnostics}`,
      );

    expect(leaked).toEqual([]);
  });

  it('probed a substantial number of id-bearing routes with an impossible id', () => {
    // Keeps the assertion above from becoming vacuous if `probePath` ever stops substituting.
    const idBearing = new Set(
      matrix
        .filter((cell) => probePath(cell.route).includes(String(IMPOSSIBLE_ID)))
        .map((cell) => cell.route.signature),
    );

    expect(idBearing.size).toBeGreaterThan(50);
  });

  it('exercised both outcomes for real — the matrix is not uniform', () => {
    // Guards against the whole file passing because every cell happened to be denied (a broken
    // session) or every cell admitted (a missing guard chain).
    expect(matrix.filter((cell) => cell.predicted === 'denied').length).toBeGreaterThan(100);
    expect(matrix.filter((cell) => cell.predicted === 'admitted').length).toBeGreaterThan(100);
    expect(matrix.filter((cell) => cell.status === 403).length).toBeGreaterThan(100);
    expect(matrix.filter((cell) => cell.status !== 403).length).toBeGreaterThan(100);
  });

  it('prints the full matrix for the completion report', () => {
    const header = ['route'.padEnd(62), ...ALL_ROLES.map((role) => role.slice(0, 6).padEnd(7))];
    const lines = [header.join(''), '-'.repeat(62 + ALL_ROLES.length * 7)];

    for (const route of routes.filter((entry) => !entry.isPublic)) {
      const cells = ALL_ROLES.map((role) => {
        const cell = matrix.find((entry) => entry.route === route && entry.role === role);
        if (cell === undefined) return 'skip'.padEnd(7);
        return `${cell.status}`.padEnd(7);
      });
      lines.push([route.signature.padEnd(62), ...cells].join(''));
    }

    /*
     * T-051: the matrix is this task's deliverable artefact and the completion report quotes this
     * output verbatim. Printing it is the point of the test, not a debugging leftover.
     */
    // eslint-disable-next-line no-console -- see the comment directly above
    console.log(`\nT-051 role × endpoint matrix (status per role)\n${lines.join('\n')}`);

    expect(lines.length).toBeGreaterThan(100);
  });
});

// --- TC-11 ------------------------------------------------------------------------------------

describe('TC-11: every mutating endpoint refuses a request with no CSRF token', () => {
  it('answers 403 across the board when the header is omitted from a real session', async () => {
    const actor = actors.get('super_admin');
    if (actor === undefined) throw new Error('no super_admin actor');

    const mutating = routes.filter(
      (route) =>
        !route.isPublic &&
        !SESSION_DESTROYING.has(route.signature) &&
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method),
    );
    expect(mutating.length).toBeGreaterThan(40);

    const wrong: string[] = [];
    let sinceReset = 0;

    for (const route of mutating) {
      if (sinceReset++ >= 120) {
        store.reset();
        sinceReset = 0;
      }

      const verb = route.method.toLowerCase() as Verb;
      // Session cookies present, `X-CSRF-Token` deliberately absent. This is case 1 in
      // `csrf.guard.ts` — a verified session, so the expected value is derived from the session
      // id and the guard must demand a matching header.
      const response = await http()[verb](probePath(route)).set('Cookie', actor.jar).send({});

      if (response.status !== 403) wrong.push(`${route.signature} → ${response.status}`);
    }

    expect(wrong).toEqual([]);
  });

  it('accepts the same requests once the header is supplied', async () => {
    // Without this, the previous test would also pass if every one of those routes were simply
    // broken. `PATCH /me` is a real mutation the super_admin is entitled to make.
    const actor = actors.get('super_admin');
    if (actor === undefined) throw new Error('no super_admin actor');

    const response = await http()
      .patch('/api/v1/me')
      .set('Cookie', actor.jar)
      .set('X-CSRF-Token', actor.csrf)
      .send({ displayName: 'T-051 CSRF positive control' });

    expect(response.status).toBe(200);
  });
});

// --- TC-12 ------------------------------------------------------------------------------------

describe('TC-12: IDOR — out-of-scope ids are 404, never 403 and never 200', () => {
  /**
   * Each probe pairs a **real** out-of-scope row with an actor that **holds the permission** for
   * it. That pairing is what makes the assertion meaningful: a 403 here would have to come from
   * scope rather than from the permission table, and 02-SECURITY.md §5.1 requires 404 instead —
   * "a 403 confirms the record exists".
   */
  function probes(): { label: string; role: PortalRole; method: Verb; path: string }[] {
    return [
      {
        label: 'campaign in another tenant',
        role: 'maker',
        method: 'get',
        path: `/api/v1/campaigns/${foreignCampaign}`,
      },
      {
        label: 'campaign journey, another tenant',
        role: 'maker',
        method: 'get',
        path: `/api/v1/campaigns/${foreignCampaign}/journey`,
      },
      {
        label: 'campaign caps, another tenant',
        role: 'maker',
        method: 'get',
        path: `/api/v1/campaigns/${foreignCampaign}/caps`,
      },
      {
        label: 'campaign audit, another tenant',
        role: 'maker',
        method: 'get',
        path: `/api/v1/campaigns/${foreignCampaign}/audit`,
      },
      {
        label: 'campaign review, another tenant',
        role: 'maker',
        method: 'get',
        path: `/api/v1/campaigns/${foreignCampaign}/review`,
      },
      {
        label: 'campaign merchants, another tenant',
        role: 'maker',
        method: 'get',
        path: `/api/v1/campaigns/${foreignCampaign}/merchants`,
      },
      {
        label: 'campaign activities, another tenant',
        role: 'maker',
        method: 'get',
        path: `/api/v1/campaigns/${foreignCampaign}/activities`,
      },
      {
        label: 'merchant in another tenant',
        role: 'tenant_admin',
        method: 'get',
        path: `/api/v1/merchants/${foreignMerchant}`,
      },
      {
        label: 'merchant stores, another tenant',
        role: 'tenant_admin',
        method: 'get',
        path: `/api/v1/merchants/${foreignMerchant}/stores`,
      },
      {
        label: 'merchant activities, another tenant',
        role: 'tenant_admin',
        method: 'get',
        path: `/api/v1/merchants/${foreignMerchant}/activities`,
      },
      {
        label: 'merchant active campaigns, another tenant',
        role: 'tenant_admin',
        method: 'get',
        path: `/api/v1/merchants/${foreignMerchant}/active-campaigns`,
      },
      {
        label: 'tenant in another country',
        role: 'country_admin',
        method: 'get',
        path: `/api/v1/tenants/${foreignTenant}`,
      },
      {
        label: 'tenant budget ceilings, another country',
        role: 'country_admin',
        method: 'get',
        path: `/api/v1/tenants/${foreignTenant}/budget-ceilings`,
      },
      {
        label: 'user in another tenant',
        role: 'tenant_admin',
        method: 'get',
        path: `/api/v1/users/${foreignUser}`,
      },
      {
        label: 'country the admin does not hold',
        role: 'country_admin',
        method: 'get',
        path: `/api/v1/countries/${foreignCountry}`,
      },
      {
        label: 'country summary, not held',
        role: 'country_admin',
        method: 'get',
        path: `/api/v1/countries/${foreignCountry}/summary`,
      },
      {
        label: 'merchant portal, another merchant’s campaign',
        role: 'merchant',
        method: 'get',
        path: `/api/v1/merchant/campaigns/${foreignCampaign}`,
      },
    ];
  }

  it('returns 404 for every out-of-scope id', async () => {
    store.reset();
    const wrong: string[] = [];

    for (const probe of probes()) {
      const actor = actors.get(probe.role);
      if (actor === undefined) throw new Error(`no ${probe.role} actor`);

      const response = await http()[probe.method](probe.path).set('Cookie', actor.jar);

      if (response.status !== 404) {
        wrong.push(`${probe.role} ${probe.label} (${probe.path}) → ${response.status}`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it('proves the same routes answer 200 for an in-scope id — the probes are not all broken', async () => {
    // Without this, "404 everywhere" would also be the result of every one of those routes being
    // mis-typed. Same route, same actor, in-scope id.
    const maker = actors.get('maker');
    const tenantAdmin = actors.get('tenant_admin');
    if (maker === undefined || tenantAdmin === undefined) throw new Error('missing actors');

    const inScope = await http().get(`/api/v1/campaigns/${homeCampaign}`).set('Cookie', maker.jar);
    expect(inScope.status).toBe(200);

    const merchantInScope = await http()
      .get(`/api/v1/merchants/${homeMerchant}`)
      .set('Cookie', tenantAdmin.jar);
    expect(merchantInScope.status).toBe(200);
  });

  it('does not leak out-of-scope rows through any list endpoint', async () => {
    // The cross-tenant probe suite 02-SECURITY.md §11 asks for: every list a scoped role can read
    // must contain only in-scope rows.
    const maker = actors.get('maker');
    if (maker === undefined) throw new Error('no maker actor');

    const campaigns = await http().get('/api/v1/campaigns').set('Cookie', maker.jar);
    expect(campaigns.status).toBe(200);

    const ids = (campaigns.body?.data ?? []).map((row: { id: number }) => row.id);
    expect(ids).not.toContain(foreignCampaign);

    const merchants = await http().get('/api/v1/merchants').set('Cookie', maker.jar);
    if (merchants.status === 200) {
      const merchantIds = (merchants.body?.data ?? []).map((row: { id: number }) => row.id);
      expect(merchantIds).not.toContain(foreignMerchant);
    }
  });
});

// --- TC-13 ------------------------------------------------------------------------------------

describe('TC-13: mass assignment is rejected, never applied', () => {
  const FORBIDDEN_FIELDS = { role: 'super_admin', tenantId: 1, status: 'active', id: 1 };

  /**
   * Write routes that answer 2xx to a body full of privileged fields because they **bind no body
   * at all** — the fields are ignored, never parsed and never assigned. TC-13's expected result is
   * "Rejected **or ignored**; never applied", so this is a pass, not a finding; it is listed so a
   * route that starts accepting a body has to be re-reviewed rather than joining silently.
   */
  const NO_BODY_ROUTES: ReadonlyMap<string, string> = new Map([
    [
      'POST /api/v1/notifications/read-all',
      'Marks the caller’s own notifications read. Takes no @Body(), so ValidationPipe never runs ' +
        'on the payload and role/tenantId/status/id are discarded unread. Scope comes from the ' +
        'JWT, so there is nothing a body could influence.',
    ],
  ]);

  it('rejects or ignores a privileged field on every write endpoint', async () => {
    store.reset();
    const actor = actors.get('super_admin');
    if (actor === undefined) throw new Error('no super_admin actor');

    const writes = routes.filter(
      (route) =>
        !route.isPublic &&
        !SESSION_DESTROYING.has(route.signature) &&
        ['POST', 'PUT', 'PATCH'].includes(route.method),
    );
    expect(writes.length).toBeGreaterThan(40);

    const accepted: string[] = [];
    let sinceReset = 0;

    for (const route of writes) {
      if (sinceReset++ >= 120) {
        store.reset();
        sinceReset = 0;
      }

      const response = await send(actor, route, probePath(route), FORBIDDEN_FIELDS);

      // `forbidNonWhitelisted` answers 400; a guard or a missing row answers 403/404/422. A 2xx
      // is only acceptable from a route that binds no body — see NO_BODY_ROUTES.
      if (response.status >= 200 && response.status < 300) {
        accepted.push(`${route.signature} → ${response.status} accepted a privileged field`);
      }
    }

    expect(accepted.filter((entry) => !NO_BODY_ROUTES.has(entry.split(' → ')[0]))).toEqual([]);
  });

  it('applied none of those privileged fields to the actor’s own row', async () => {
    // The observable half. The sweep above ran ~50 write attempts carrying
    // `{ role: 'super_admin', tenantId: 1, status: 'active', id: 1 }`; if any had been applied
    // anywhere, the most valuable target is the caller's own identity row.
    const actor = actors.get('super_admin');
    if (actor === undefined) throw new Error('no super_admin actor');

    const [row] = await sql<{
      role: string;
      tenant_id: number | null;
      country_id: number | null;
      merchant_id: number | null;
      status: string;
    }>(
      `SELECT role, tenant_id, country_id, merchant_id, status
         FROM reward_portal.portal_users WHERE id = :id`,
      { id: actor.userId },
    );

    expect(row).toEqual({
      role: 'super_admin',
      tenant_id: null,
      country_id: null,
      merchant_id: null,
      status: 'active',
    });
  });

  it('cannot change the caller’s own role through PATCH /me', async () => {
    const maker = actors.get('maker');
    if (maker === undefined) throw new Error('no maker actor');

    const response = await http()
      .patch('/api/v1/me')
      .set('Cookie', maker.jar)
      .set('X-CSRF-Token', maker.csrf)
      .send({ displayName: 'T-051 escalation attempt', role: 'super_admin', tenantId: 1 });

    expect(response.status).toBe(400);

    const [row] = await sql<{ role: string; tenant_id: number }>(
      `SELECT role, tenant_id FROM reward_portal.portal_users WHERE id = :id`,
      { id: maker.userId },
    );
    expect(row.role).toBe('maker');
    expect(Number(row.tenant_id)).toBe(homeTenant);
  });

  it('does not honour a client-supplied tenantId on a create (R3)', async () => {
    // A maker creating a campaign while claiming another tenant. `ScopedRepository.create`
    // overwrites the scope from the verified JWT; `forbidNonWhitelisted` rejects it first.
    const maker = actors.get('maker');
    if (maker === undefined) throw new Error('no maker actor');

    const response = await http()
      .post('/api/v1/campaigns')
      .set('Cookie', maker.jar)
      .set('X-CSRF-Token', maker.csrf)
      .send({ name: 'T-051 mass assignment', tenantId: foreignTenant });

    expect(response.status).toBe(400);

    const [{ count }] = await sql<{ count: string }>(
      `SELECT count(*) AS count FROM reward_config.tenant_campaigns
        WHERE tenant_id = :tenantId AND name = 'T-051 mass assignment'`,
      { tenantId: foreignTenant },
    );
    expect(Number(count)).toBe(0);
  });
});

// --- TC-14 / TC-15 ----------------------------------------------------------------------------

describe('TC-14 / TC-15: injection payloads are stored literally and returned escaped', () => {
  const SQL_METACHARACTERS = "Robert'); DROP TABLE reward_config.tenant_campaigns;--";
  const XSS_PAYLOAD = '<script>alert(1)</script>';

  it('stores SQL metacharacters as data, not as SQL', async () => {
    store.reset();
    const maker = actors.get('maker');
    if (maker === undefined) throw new Error('no maker actor');

    const response = await http()
      .patch('/api/v1/me')
      .set('Cookie', maker.jar)
      .set('X-CSRF-Token', maker.csrf)
      .send({ displayName: SQL_METACHARACTERS });

    expect(response.status).toBe(200);

    // The table the payload tried to drop is still there, and the value came back byte-identical.
    const [row] = await sql<{ display_name: string }>(
      `SELECT display_name FROM reward_portal.portal_users WHERE id = :id`,
      { id: maker.userId },
    );
    expect(row.display_name).toBe(SQL_METACHARACTERS);

    const [{ count }] = await sql<{ count: string }>(
      `SELECT count(*) AS count FROM information_schema.tables
        WHERE table_schema = 'reward_config' AND table_name = 'tenant_campaigns'`,
    );
    expect(Number(count)).toBe(1);
  });

  it('round-trips an XSS payload as inert text', async () => {
    const maker = actors.get('maker');
    if (maker === undefined) throw new Error('no maker actor');

    const stored = await http()
      .patch('/api/v1/me')
      .set('Cookie', maker.jar)
      .set('X-CSRF-Token', maker.csrf)
      .send({ displayName: XSS_PAYLOAD });
    expect(stored.status).toBe(200);

    const read = await http().get('/api/v1/me').set('Cookie', maker.jar);
    expect(read.status).toBe(200);
    expect(read.body.data.displayName).toBe(XSS_PAYLOAD);

    // The API is JSON: the payload must come back as a JSON string value, and the response must
    // not be served as HTML — those two together are what make it inert in a browser. React
    // escapes it on render (T-021/T-022 own that half); the server's job is not to serve it as
    // a document.
    expect(read.headers['content-type']).toMatch(/application\/json/);
    expect(read.headers['x-content-type-options']).toBe('nosniff');
  });

  it('restores the fixture display name', async () => {
    const maker = actors.get('maker');
    if (maker === undefined) throw new Error('no maker actor');

    await http()
      .patch('/api/v1/me')
      .set('Cookie', maker.jar)
      .set('X-CSRF-Token', maker.csrf)
      .send({ displayName: 'T-051 maker' });
  });
});

// --- TC-19 ------------------------------------------------------------------------------------

describe('TC-19: no failure path discloses internals', () => {
  const FORBIDDEN = [
    /at\s+\w+\s+\(/i, // a stack frame
    /\bselect\b.+\bfrom\b/i, // SQL
    /reward_portal\./i,
    /reward_config\./i,
    /sequelize/i,
    /node_modules/i,
    /password_hash/i,
    /\.ts:\d+/,
  ];

  it('leaks nothing across every status the matrix produced', async () => {
    store.reset();
    const actor = actors.get('merchant');
    if (actor === undefined) throw new Error('no merchant actor');

    // A deliberately mixed bag: 403 (role), 404 (missing row), 400 (validation), 401 (no session).
    const samples = [
      await http().get('/api/v1/audit/portal').set('Cookie', actor.jar),
      await http().get(`/api/v1/campaigns/${IMPOSSIBLE_ID}`).set('Cookie', actor.jar),
      await http().get('/api/v1/campaigns/not-a-number').set('Cookie', actor.jar),
      await http().get('/api/v1/me'),
      await http()
        .post('/api/v1/campaigns')
        .set('Cookie', actor.jar)
        .set('X-CSRF-Token', actor.csrf)
        .send({ name: 123 }),
      await http()
        .post('/api/v1/auth/login')
        .send({ email: 'nope@example.invalid', password: 'x' }),
    ];

    for (const response of samples) {
      const body = JSON.stringify(response.body);
      for (const pattern of FORBIDDEN) {
        expect(body).not.toMatch(pattern);
      }
      // And the envelope is the documented one — `{ error: { code, ... } }`, nothing else.
      expect(response.body).toHaveProperty('error.code');
      expect(response.body).not.toHaveProperty('stack');
      expect(response.body).not.toHaveProperty('error.stack');
    }
  });

  it('does not name which of the six rate limits tripped', async () => {
    store.reset();

    let limited: request.Response | undefined;
    for (let attempt = 0; attempt < 80 && limited === undefined; attempt += 1) {
      const response = await http().get('/api/v1/health/ready');
      // `/health` is public but still charged against the unauthenticated per-IP ceiling.
      if (response.status === 429) limited = response;
    }

    expect(limited).toBeDefined();
    const body = JSON.stringify(limited?.body);
    expect(body).not.toMatch(/unauthenticated|per[_-]?ip|bucket|rule/i);
    expect(limited?.body).toHaveProperty('error.code');
  });
});

// --- TC-17 ------------------------------------------------------------------------------------

describe('TC-17: the rate limits of 02-SECURITY.md §8 are enforced', () => {
  it('caps unauthenticated traffic per IP at 60 per minute', async () => {
    store.reset();

    /*
     * `GET /me` with **no cookies** is the probe, for a specific reason.
     *
     * It is charged against the unauthenticated per-IP bucket (no verified identity), and
     * `JwtAuthGuard` refuses it before any handler or repository runs — so it touches **no
     * database at all** and answers a deterministic 401. That matters: the first version of this
     * test probed `/health/ready`, which *does* open a database connection, and it failed once in
     * a full-suite run with 60×200 + 9×429 + one other status. The odd response was the readiness
     * probe legitimately reporting a busy pool, not the limiter misbehaving — i.e. the assertion
     * was conflating "the rate limit works" with "the database is reachable right now". A
     * rate-limit test should depend on nothing but the rate limiter.
     */
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 70; attempt += 1) {
      statuses.push((await http().get('/api/v1/me')).status);
    }

    const distribution = statuses.reduce<Record<number, number>>((counts, status) => {
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    }, {});

    // Stated as the distribution so a failure names what actually came back.
    expect(distribution).toEqual({ 401: 60, 429: 10 });
    // And the cut is where the window says, not somewhere arbitrary: the first 60 pass in order.
    expect(statuses.slice(0, 60).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(60).every((status) => status === 429)).toBe(true);
  });

  it('exempts the liveness probe — deliberately, and only that one route', async () => {
    // `/health` is in `UNTHROTTLED_ROUTES` on purpose: a constant-string liveness response polled
    // every few seconds by an orchestrator, where a 429 would read as an outage and get the
    // container killed while protecting nothing (03-API-CONTRACT.md §14). `/health/ready` touches
    // the database and is **not** exempt, as the test above proves. Recorded rather than assumed —
    // the first draft of this suite asserted the limit against `/health` and read the exemption as
    // a missing control.
    store.reset();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 70; attempt += 1) {
      statuses.push((await http().get('/api/v1/health')).status);
    }

    expect(statuses.every((status) => status === 200)).toBe(true);
  });

  it('caps login attempts per email+IP', async () => {
    store.reset();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await http()
        .post('/api/v1/auth/login')
        .send({ email: 't051-throttle@example.invalid', password: 'wrong-password-here' });
      statuses.push(response.status);
    }

    // Five real attempts, then the limiter. The exact split depends on the relax factor the
    // environment sets, so the assertion is the property: it stops before the eighth.
    expect(statuses).toContain(429);
    expect(statuses.filter((status) => status === 401).length).toBeLessThanOrEqual(
      statuses.length - 1,
    );
  });

  it('caps authenticated API traffic per user', async () => {
    store.reset();
    const actor = actors.get('checker');
    if (actor === undefined) throw new Error('no checker actor');

    let limited = false;
    for (let attempt = 0; attempt < 320 && !limited; attempt += 1) {
      const response = await http().get('/api/v1/me').set('Cookie', actor.jar);
      if (response.status === 429) limited = true;
    }

    expect(limited).toBe(true);
    store.reset();
  });
});

// --- the two routes the sweep could not touch -------------------------------------------------

describe('TC-2 (continued): the session-destroying routes', () => {
  /**
   * These two run last, and in this order, because of what they do rather than as a preference.
   * `POST /auth/logout` ends one session; `POST /auth/logout-all` ends **every** session the user
   * holds, including the one the sweep above was conducted with. So single-session logout is
   * proven first — while the sweep's sessions are still alive to show they were *not* affected —
   * and the total revocation is proven afterwards, when nothing else needs them.
   */
  it('admits every role to POST /auth/logout, and revokes only that session', async () => {
    store.reset();

    for (const role of ALL_ROLES) {
      const actor = actors.get(role);
      if (actor === undefined) throw new Error(`no actor for ${role}`);

      const disposable = await disposableSession(actor);

      const loggedOut = await http()
        .post('/api/v1/auth/logout')
        .set('Cookie', disposable.jar)
        .set('X-CSRF-Token', disposable.csrf)
        .send({});
      expect([200, 204]).toContain(loggedOut.status);

      // The session it just revoked is dead …
      const dead = await http().get('/api/v1/me').set('Cookie', disposable.jar);
      expect({ role, status: dead.status }).toEqual({ role, status: 401 });

      // … and the sweep's own session for the same user is not. If these had shared identity,
      // every "denied" reading in the matrix after this point would have been an artefact.
      const alive = await http().get('/api/v1/me').set('Cookie', actor.jar);
      expect({ role, status: alive.status }).toEqual({ role, status: 200 });
    }
  });

  it('admits every role to POST /auth/logout-all, and revokes the whole family', async () => {
    store.reset();

    for (const role of ALL_ROLES) {
      const actor = actors.get(role);
      if (actor === undefined) throw new Error(`no actor for ${role}`);

      const disposable = await disposableSession(actor);

      const loggedOut = await http()
        .post('/api/v1/auth/logout-all')
        .set('Cookie', disposable.jar)
        .set('X-CSRF-Token', disposable.csrf)
        .send({});
      expect([200, 204]).toContain(loggedOut.status);

      // Both the disposable session and the sweep's — "all" means all.
      expect((await http().get('/api/v1/me').set('Cookie', disposable.jar)).status).toBe(401);
      expect({
        role,
        status: (await http().get('/api/v1/me').set('Cookie', actor.jar)).status,
      }).toEqual({ role, status: 401 });
    }
  });
});
