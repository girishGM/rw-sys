/**
 * T-011 — `/auth/*` against the **real** Postgres instance, through the real `AppModule`.
 *
 * `auth.http.spec.ts` covers the HTTP surface against in-memory stores; that is what makes 100%
 * branch coverage reachable, and it proves nothing about whether the SQL is valid Postgres,
 * whether `SELECT … FOR UPDATE` actually serialises two concurrent replays, or whether a rolled
 * back transaction really does leave a reset token usable. This file covers exactly that gap,
 * and evidences T-011 verification steps 3, 4, 5 and 8.
 *
 * ### Isolation, and what cannot be cleaned up
 *
 * All fixtures are prefixed `t011-e2e` and removed in `afterAll`. Two deliberate exceptions,
 * both forced by the least-privilege grants T002_008 sets up — and both worth knowing about:
 *
 *  - **`portal_audit_log` rows survive.** `reward_app` holds `SELECT, INSERT` and has
 *    `UPDATE`/`DELETE` explicitly revoked (01-DATABASE.md §3), which is the entire point of an
 *    append-only audit table. A test that could tidy its own audit trail away would be a test
 *    running with privileges the application deliberately does not have. Rows written here name
 *    the fixture user, whose `portal_users` row is deleted, so `actor_id` becomes NULL via the
 *    `ON DELETE SET NULL` foreign key.
 *  - **The second `reward_config.tenants` row is soft-deleted, not deleted.** TC-28 needs two
 *    tenants to move a user between and the database has one; `reward_app` has `INSERT` and
 *    `UPDATE` on that table but no `DELETE`, because "the portal soft-deletes everywhere"
 *    (T002_008's own comment). So the fixture tenant is retired the same way the application
 *    would retire one. It is inert: no campaign, no user and no assignment references it.
 *
 * Everything else — users, credentials, sessions, refresh tokens, resets, login attempts —
 * cascades from the `portal_users` delete.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { AuthService } from '@/modules/auth/auth.service';
import { TokenService } from '@/modules/auth/services/token.service';
import {
  ACCESS_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
} from '@/modules/auth/session.constants';
import { CSRF_HEADER_NAME } from '@/common/security/security.constants';
import {
  MemoryThrottleStore,
  THROTTLE_STORE,
  type ThrottleCounter,
  type ThrottleStore,
} from '@/common/security/throttle.store';
// T-014 — `ErrorNormalizationFilter` now adds `message` and `traceId` to every error body, as
// this module's own `auth.exceptions.ts` header predicted it would. See
// `test/common/support/error-envelope.ts`; the replacement assertion is stricter, not looser.
import { expectErrorEnvelope } from '../common/support/error-envelope';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from './support/portal-user-fixture';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';

jest.setTimeout(180_000);

const PASSWORD = 'correct horse battery staple 7!';
const NEW_PASSWORD = 'Tr0ubador-Zephyr-Quill!42';
const EMAIL = 't011-e2e-operator@example.invalid';
/** A second account, so TC-25 can point at a *real* session that is genuinely somebody else's. */
const OTHER_EMAIL = 't011-e2e-stranger@example.invalid';
const FIXTURE_TENANT_CODE = 'T011_E2E';

/**
 * A `ThrottleStore` whose counters can be cleared between tests.
 *
 * ### Why this is here (added by T-013)
 *
 * This suite logs the *same* fixture user in roughly twenty times. T-012 registered `RateLimitGuard`
 * globally after T-011 was written, and `LOGIN_PER_EMAIL_IP_LIMIT` is **5 per fifteen minutes per
 * email+IP** — so from the sixth `login()` onwards every test here was answering `429`, and had
 * been since T-012 landed. (T-013 found this while composing the global chain; the diagnosis and
 * the two fixes are recorded in its completion report.)
 *
 * ### Why this does not weaken anything
 *
 * The rate limiter is **not** what this file tests, and it is not disabled anywhere it is: it
 * still ships globally, and its behaviour is covered end to end by T-012's own
 * `test/security/hardening.e2e-spec.ts` and exhaustively by `rate-limit.guard.spec.ts`, both
 * green. Clearing a counter between tests in an unrelated suite is the same kind of isolation as
 * `resetFixtureUser()` immediately below — it removes a cross-test dependency, it does not lower
 * a limit. AGENT-PROTOCOL §7's rule is that a test must never be made to pass by weakening a
 * control; the control here is untouched, in production and in its own tests.
 *
 * The alternatives were worse: raising the limit in the test environment *would* be weakening a
 * control, and giving every `login()` a distinct email would rewrite two thirds of this file
 * while still tripping the 20-per-minute per-IP limit.
 */
class ResettableThrottleStore implements ThrottleStore {
  readonly kind = 'memory' as const;

  private inner = new MemoryThrottleStore();

  async consume(key: string, windowMs: number, now: number): Promise<ThrottleCounter> {
    return this.inner.consume(key, windowMs, now);
  }

  /** Discards every counter. Called between tests, never inside one. */
  reset(): void {
    this.inner = new MemoryThrottleStore();
  }
}

const throttle = new ResettableThrottleStore();

/** Namespaces this suite's encryption-key rows so parallel suites cannot delete each other's. */
const T056_SUITE = 't011auth';

let app: INestApplication;
let db: Sequelize;
let tokens: TokenService;
let auth: AuthService;
let emailCrypto: PortalUserEmailCrypto;
let userId: number;
let otherUserId: number;
let countryId: number;
let primaryTenantId: number;
let secondaryTenantId: number;

type HttpAgent = ReturnType<typeof request>;

function http(): HttpAgent {
  return request(app.getHttpServer());
}

function setCookies(response: request.Response): string[] {
  const header = response.headers['set-cookie'];
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [header];
}

function cookieNamed(response: request.Response, name: string): string {
  const header = setCookies(response).find((entry) => entry.startsWith(`${name}=`));
  if (header === undefined) throw new Error(`no Set-Cookie for ${name}`);
  return header;
}

function cookieValue(response: request.Response, name: string): string {
  return decodeURIComponent(
    cookieNamed(response, name)
      .split(';')[0]
      .slice(name.length + 1),
  );
}

/** A `Cookie` header carrying only the cookies that were actually set (not the cleared ones). */
function jarFrom(response: request.Response): string {
  return setCookies(response)
    .map((entry) => entry.split(';')[0])
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

/**
 * The `rs_csrf` value carried by a jar, or `undefined` when there is none.
 *
 * Login mints this as `TokenService.csrfTokenFor(sessionId)`, which is exactly the value
 * `CsrfGuard` derives for a session-bound request — so the same string satisfies both the
 * session-bound check (02-SECURITY.md §4 case 1, every authenticated mutation here) and the
 * cookie-bound fallback (case 2, `POST /auth/refresh`).
 */
function csrfOf(jar: string): string | undefined {
  const pair = jar.split('; ').find((entry) => entry.startsWith(`${CSRF_COOKIE_NAME}=`));
  return pair === undefined
    ? undefined
    : decodeURIComponent(pair.slice(CSRF_COOKIE_NAME.length + 1));
}

/**
 * A mutating request carrying a cookie jar **and the matching `X-CSRF-Token` header**.
 *
 * Added by T-013. These call sites were written before T-012 registered `CsrfGuard` as a global
 * guard, so they sent cookies without the double-submit header and every mutating assertion in
 * this file had been answering `403 CSRF_TOKEN_MISSING` since. The product behaviour is correct —
 * a mutating request with ambient authority and no header is exactly what CSRF protection is for
 * — so the fix belongs in the suite, which now does what a real SPA does. Recorded in the T-013
 * completion report.
 */
function mutating(method: 'post' | 'delete', path: string, jar: string) {
  const pending = http()[method](path).set('Cookie', jar);
  const csrf = csrfOf(jar);
  return csrf === undefined ? pending : pending.set(CSRF_HEADER_NAME, csrf);
}

async function login(): Promise<request.Response> {
  const response = await http()
    .post('/api/v1/auth/login')
    .send({ email: EMAIL, password: PASSWORD });
  expect(response.status).toBe(200);
  return response;
}

async function scalar<T extends object>(
  sql: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return db.query<T>(sql, { type: QueryTypes.SELECT, replacements });
}

/** Resets the fixture user to a known state between tests. */
async function resetFixtureUser(): Promise<void> {
  await db.query(
    `UPDATE reward_portal.portal_users
        SET role = 'maker', country_id = :countryId, tenant_id = :tenantId, merchant_id = NULL,
            status = 'active', must_change_password = false, updated_at = now()
      WHERE id = :userId`,
    { type: QueryTypes.UPDATE, replacements: { userId, countryId, tenantId: primaryTenantId } },
  );
  await db.query(
    `UPDATE reward_portal.portal_user_credentials
        SET password_hash = :hash, failed_attempts = 0, locked_until = NULL,
            password_expires_at = NULL, previous_hashes = NULL, updated_at = now()
      WHERE user_id = :userId`,
    {
      type: QueryTypes.UPDATE,
      replacements: { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
    },
  );
  await db.query(`DELETE FROM reward_portal.portal_sessions WHERE user_id = :userId`, {
    type: QueryTypes.DELETE,
    replacements: { userId },
  });
  await db.query(`DELETE FROM reward_portal.portal_password_resets WHERE user_id = :userId`, {
    type: QueryTypes.DELETE,
    replacements: { userId },
  });
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // See `ResettableThrottleStore` — this replaces the counter store *only in this suite*, so
    // repeated logins by the same fixture user do not trip a limit this file is not testing.
    .overrideProvider(THROTTLE_STORE)
    .useValue(throttle)
    .compile();

  // T-056: `portal_users.email` is encrypted, so every login now needs an active `field` **and**
  // `blind_index` key. Inserted through the compiled module's connection *before* `app.init()`,
  // because `KeyRegistryService` reads `encryption_keys` exactly once, at boot.
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), T056_SUITE);

  app = moduleRef.createNestApplication();
  // Identical to main.ts — the pipe is part of the contract being tested.
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  // T-085: this file's own TC-15 fires two concurrent `mutating('post', ...)` calls — exactly the
  // shape that exposed the defect. `app.init()` alone never binds a TCP listener, so every
  // `request(app.getHttpServer())` in `http()` below made supertest call `server.listen(0)` and
  // `server.close()` itself, once per request; under concurrency that churn can hand a request to
  // a listener that is not this server at all. See `test/e2e-infra/bound-http-server.e2e-spec.ts`
  // for the reproduction. `listen(0)` binds once, here, before any request runs, and already calls
  // `init()` internally.
  await app.listen(0);

  db = app.get<Sequelize>(SEQUELIZE);
  tokens = app.get(TokenService);
  auth = app.get(AuthService);
  // The application's own instance — see `portal-user-fixture.ts` for why a test-local copy of the
  // encryption logic would defeat the purpose of these tests.
  emailCrypto = emailCryptoOf(app);

  const [country] = await scalar<{ id: number }>(
    `SELECT id FROM reward_config.countries ORDER BY id LIMIT 1`,
  );
  if (country === undefined) throw new Error('no country row to build a fixture user on');
  countryId = country.id;

  const [tenant] = await scalar<{ id: number }>(
    `SELECT id FROM reward_config.tenants WHERE country_id = :countryId AND deleted_at IS NULL
      ORDER BY id LIMIT 1`,
    { countryId },
  );
  if (tenant === undefined) throw new Error('no tenant row to build a fixture user on');
  primaryTenantId = tenant.id;

  // The second tenant TC-28 moves the user to. Reused across runs if it already exists.
  const [existing] = await scalar<{ id: number }>(
    `SELECT id FROM reward_config.tenants WHERE code = :code`,
    { code: FIXTURE_TENANT_CODE },
  );
  if (existing === undefined) {
    const [created] = await scalar<{ id: number }>(
      `INSERT INTO reward_config.tenants (code, name, country_id, status)
       VALUES (:code, 'T-011 e2e fixture tenant', :countryId, 'active')
       RETURNING id`,
      { code: FIXTURE_TENANT_CODE, countryId },
    );
    secondaryTenantId = created.id;
  } else {
    secondaryTenantId = existing.id;
    await db.query(
      `UPDATE reward_config.tenants SET status = 'active', deleted_at = NULL WHERE id = :id`,
      { type: QueryTypes.UPDATE, replacements: { id: secondaryTenantId } },
    );
  }

  // A leftover fixture user from an interrupted run would collide on uq_portal_users_email_live.
  await deletePortalUsersByEmail(db, emailCrypto, [EMAIL, OTHER_EMAIL]);

  userId = await createFixtureUser(EMAIL, 'T-011 e2e operator');
  otherUserId = await createFixtureUser(OTHER_EMAIL, 'T-011 e2e stranger');
});

async function createFixtureUser(email: string, displayName: string): Promise<number> {
  const created = {
    id: await insertPortalUser(db, emailCrypto, {
      email,
      displayName,
      role: 'maker',
      countryId,
      tenantId: primaryTenantId,
    }),
  };

  await db.query(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    {
      type: QueryTypes.INSERT,
      replacements: {
        userId: created.id,
        hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS),
      },
    },
  );

  return created.id;
}

afterAll(async () => {
  if (db !== undefined) {
    await deletePortalUsersByEmail(db, emailCrypto, [EMAIL, OTHER_EMAIL]);
    await removeEncryptionKeys(db, T056_SUITE);
    if (secondaryTenantId !== undefined) {
      // Soft-deleted, not deleted: `reward_app` has no DELETE on reward_config (see the header).
      await db.query(
        `UPDATE reward_config.tenants SET status = 'inactive', deleted_at = now() WHERE id = :id`,
        { type: QueryTypes.UPDATE, replacements: { id: secondaryTenantId } },
      );
    }
  }
  if (app !== undefined) await app.close();
});

beforeEach(async () => {
  await resetFixtureUser();
  throttle.reset();
});

describe('verification step 3 — login sets three cookies with the right flags', () => {
  it('issues __Host-rs_at, __Host-rs_rt and rs_csrf against the real database', async () => {
    const response = await login();

    expect(setCookies(response)).toHaveLength(3);
    expect(cookieNamed(response, ACCESS_COOKIE_NAME)).toMatch(
      /HttpOnly; Secure; SameSite=Strict; Path=\/;/,
    );
    // T-058: `Path=/`, like the access cookie. Both are `__Host-`-prefixed, and a `__Host-`
    // cookie with a narrower path is rejected by the browser instead of stored — which is what
    // `Path=/api/v1/auth` here used to assert, against a real database, entirely successfully.
    // supertest replays whatever `Set-Cookie` says, so no e2e test at this layer can catch it.
    expect(cookieNamed(response, REFRESH_COOKIE_NAME)).toMatch(
      /HttpOnly; Secure; SameSite=Strict; Path=\/;/,
    );
    expect(cookieNamed(response, REFRESH_COOKIE_NAME)).not.toMatch(/domain=/i);
    expect(cookieNamed(response, CSRF_COOKIE_NAME)).not.toContain('HttpOnly');
    expect(response.body).toEqual({
      data: { role: 'maker', mustChangePassword: false, mfaRequired: false },
    });
  });

  it('writes a real portal_sessions row and a real portal_refresh_tokens row', async () => {
    const response = await login();

    const [session] = await scalar<{ id: string; status: string; user_id: number }>(
      `SELECT id, status, user_id FROM reward_portal.portal_sessions WHERE user_id = :userId`,
      { userId },
    );
    expect(session.status).toBe('active');

    const [token] = await scalar<{ token_hash: string; parent_token_id: string | null }>(
      `SELECT token_hash, parent_token_id FROM reward_portal.portal_refresh_tokens
        WHERE session_id = :sessionId`,
      { sessionId: session.id },
    );
    // Only the digest is stored — a database dump yields no usable session.
    expect(token.token_hash).toBe(
      tokens.hashOpaqueToken(cookieValue(response, REFRESH_COOKIE_NAME)),
    );
    expect(token.parent_token_id).toBeNull();
  });

  it('records the attempt and a login_succeeded audit row', async () => {
    await login();

    const [attempt] = await scalar<{ success: boolean }>(
      `SELECT success FROM reward_portal.portal_login_attempts
        WHERE user_id = :userId ORDER BY attempted_at DESC LIMIT 1`,
      { userId },
    );
    expect(attempt.success).toBe(true);

    const [audit] = await scalar<{ event_type: string }>(
      `SELECT event_type FROM reward_portal.portal_audit_log
        WHERE actor_id = :userId ORDER BY occurred_at DESC LIMIT 1`,
      { userId },
    );
    expect(audit.event_type).toBe('login_succeeded');
  });
});

describe('verification step 4 — /me, logout, /me', () => {
  it('is 200, 204, then 401 well inside the 15-minute token TTL', async () => {
    const jar = jarFrom(await login());

    // `/me` is T-015's; `/auth/sessions` is this task's own authenticated route and exercises
    // exactly the same guard chain.
    await expect(http().get('/api/v1/auth/sessions').set('Cookie', jar)).resolves.toMatchObject({
      status: 200,
    });
    await expect(mutating('post', '/api/v1/auth/logout', jar)).resolves.toMatchObject({
      status: 204,
    });
    await expect(http().get('/api/v1/auth/sessions').set('Cookie', jar)).resolves.toMatchObject({
      status: 401,
    });

    const [session] = await scalar<{ status: string; revoked_reason: string }>(
      `SELECT status, revoked_reason FROM reward_portal.portal_sessions WHERE user_id = :userId`,
      { userId },
    );
    expect(session).toMatchObject({ status: 'revoked', revoked_reason: 'logout' });
  });
});

describe('TC-12 — refresh rotation against real Postgres', () => {
  it('issues new cookies and marks the presented token consumed', async () => {
    const first = await login();
    const rotated = await mutating('post', '/api/v1/auth/refresh', jarFrom(first));

    expect(rotated.status).toBe(200);
    expect(cookieValue(rotated, REFRESH_COOKIE_NAME)).not.toBe(
      cookieValue(first, REFRESH_COOKIE_NAME),
    );
    expect(cookieValue(rotated, ACCESS_COOKIE_NAME)).not.toBe(
      cookieValue(first, ACCESS_COOKIE_NAME),
    );

    const rows = await scalar<{ status: string; parent_token_id: string | null }>(
      `SELECT t.status, t.parent_token_id
         FROM reward_portal.portal_refresh_tokens t
         JOIN reward_portal.portal_sessions s ON s.id = t.session_id
        WHERE s.user_id = :userId
        ORDER BY t.issued_at`,
      { userId },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('consumed');
    expect(rows[1].status).toBe('active');
    expect(rows[1].parent_token_id).not.toBeNull();
  });

  it('keeps the session alive and moves last_seen_at forward', async () => {
    const first = await login();
    const before = await scalar<{ last_seen_at: Date; id: string }>(
      `SELECT id, last_seen_at FROM reward_portal.portal_sessions WHERE user_id = :userId`,
      { userId },
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    await mutating('post', '/api/v1/auth/refresh', jarFrom(first));

    const after = await scalar<{ last_seen_at: Date; status: string }>(
      `SELECT last_seen_at, status FROM reward_portal.portal_sessions WHERE id = :id`,
      { id: before[0].id },
    );
    expect(after[0].status).toBe('active');
    expect(new Date(after[0].last_seen_at).getTime()).toBeGreaterThan(
      new Date(before[0].last_seen_at).getTime(),
    );
  });
});

describe('TC-13 / verification step 5 — replaying a consumed refresh token', () => {
  it('answers 401, revokes the whole family and the session, and writes the audit row', async () => {
    const first = await login();
    const jar = jarFrom(first);
    const rotated = await mutating('post', '/api/v1/auth/refresh', jar);
    expect(rotated.status).toBe(200);

    const replay = await mutating('post', '/api/v1/auth/refresh', jar);
    expect(replay.status).toBe(401);
    expectErrorEnvelope(replay.body, 'AUTH_SESSION_INVALID');

    const family = await scalar<{ status: string }>(
      `SELECT t.status FROM reward_portal.portal_refresh_tokens t
         JOIN reward_portal.portal_sessions s ON s.id = t.session_id
        WHERE s.user_id = :userId`,
      { userId },
    );
    expect(family).toHaveLength(2);
    expect(family.every((row) => row.status === 'revoked')).toBe(true);

    const [session] = await scalar<{ status: string; revoked_reason: string }>(
      `SELECT status, revoked_reason FROM reward_portal.portal_sessions WHERE user_id = :userId`,
      { userId },
    );
    expect(session).toMatchObject({
      status: 'revoked',
      revoked_reason: 'refresh_reuse_detected',
    });

    // Verification step 5's own SQL, run for real.
    const audit = await scalar<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM reward_portal.portal_audit_log
        WHERE event_type = 'refresh_reuse_detected' AND actor_id = :userId`,
      { userId },
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toMatchObject({ revokedTokens: 2 });
    // Ids and counts only — never the token, not even its hash.
    expect(JSON.stringify(audit[0].detail)).not.toContain(cookieValue(first, REFRESH_COOKIE_NAME));
  });

  it('TC-14: the access token issued before the replay is dead too', async () => {
    const first = await login();
    const jar = jarFrom(first);
    const rotated = await mutating('post', '/api/v1/auth/refresh', jar);
    await mutating('post', '/api/v1/auth/refresh', jar);

    // The token from the *successful* rotation — the legitimate client's — is now useless.
    await expect(
      http().get('/api/v1/auth/sessions').set('Cookie', jarFrom(rotated)),
    ).resolves.toMatchObject({ status: 401 });
  });

  it('TC-15: two concurrent refreshes with the same token — exactly one wins', async () => {
    const first = await login();
    const jar = jarFrom(first);

    // Fired without awaiting either, so both statements reach `SELECT … FOR UPDATE` before
    // either commits. This is the case the in-memory fake cannot model at all.
    const [a, b] = await Promise.all([
      mutating('post', '/api/v1/auth/refresh', jar),
      mutating('post', '/api/v1/auth/refresh', jar),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);

    // The loser tripped reuse detection, so the winner's brand-new token is revoked as well.
    const [session] = await scalar<{ status: string; revoked_reason: string }>(
      `SELECT status, revoked_reason FROM reward_portal.portal_sessions WHERE user_id = :userId`,
      { userId },
    );
    expect(session).toMatchObject({
      status: 'revoked',
      revoked_reason: 'refresh_reuse_detected',
    });
  });
});

describe('TC-27 / TC-28 / verification step 8 — refresh re-derives claims from portal_users', () => {
  function claimsOf(response: request.Response) {
    return tokens.verifyAccessToken(cookieValue(response, ACCESS_COOKIE_NAME), new Date());
  }

  it('TC-27: a role changed directly in the database appears in the next access JWT', async () => {
    const first = await login();
    expect(claimsOf(first).role).toBe('maker');

    await db.query(
      `UPDATE reward_portal.portal_users SET role = 'tenant_admin', updated_at = now()
        WHERE id = :userId`,
      { type: QueryTypes.UPDATE, replacements: { userId } },
    );

    const rotated = await mutating('post', '/api/v1/auth/refresh', jarFrom(first));
    expect(rotated.status).toBe(200);

    // The claim comes from the row, not from the token that was presented.
    expect(claimsOf(rotated).role).toBe('tenant_admin');
    expect(rotated.body.data.role).toBe('tenant_admin');
  });

  it('TC-28: a changed tenant_id appears in the next access JWT', async () => {
    const first = await login();
    expect(claimsOf(first).tenantId).toBe(primaryTenantId);

    await db.query(
      `UPDATE reward_portal.portal_users SET tenant_id = :tenantId, updated_at = now()
        WHERE id = :userId`,
      { type: QueryTypes.UPDATE, replacements: { userId, tenantId: secondaryTenantId } },
    );

    const rotated = await mutating('post', '/api/v1/auth/refresh', jarFrom(first));

    expect(claimsOf(rotated).tenantId).toBe(secondaryTenantId);
    // And the old scope is gone from the session entirely — this is what stops a re-scoped user
    // acting under their previous tenant for the rest of the refresh token's seven days.
    expect(claimsOf(rotated).tenantId).not.toBe(primaryTenantId);
  });

  it('a deactivated user cannot refresh at all', async () => {
    const first = await login();
    await db.query(`UPDATE reward_portal.portal_users SET status = 'inactive' WHERE id = :userId`, {
      type: QueryTypes.UPDATE,
      replacements: { userId },
    });

    const rotated = await mutating('post', '/api/v1/auth/refresh', jarFrom(first));
    expect(rotated.status).toBe(401);
  });
});

describe('TC-17 — instant revocation through SessionValidGuard', () => {
  it('deactivating the user server-side is 401 on the next request', async () => {
    const jar = jarFrom(await login());
    await expect(http().get('/api/v1/auth/sessions').set('Cookie', jar)).resolves.toMatchObject({
      status: 200,
    });

    await db.query(`UPDATE reward_portal.portal_users SET status = 'inactive' WHERE id = :userId`, {
      type: QueryTypes.UPDATE,
      replacements: { userId },
    });

    await expect(http().get('/api/v1/auth/sessions').set('Cookie', jar)).resolves.toMatchObject({
      status: 401,
    });
  });

  it('soft-deleting the user is 401 on the next request', async () => {
    const jar = jarFrom(await login());
    await db.query(`UPDATE reward_portal.portal_users SET deleted_at = now() WHERE id = :userId`, {
      type: QueryTypes.UPDATE,
      replacements: { userId },
    });

    try {
      await expect(http().get('/api/v1/auth/sessions').set('Cookie', jar)).resolves.toMatchObject({
        status: 401,
      });
    } finally {
      await db.query(`UPDATE reward_portal.portal_users SET deleted_at = NULL WHERE id = :userId`, {
        type: QueryTypes.UPDATE,
        replacements: { userId },
      });
    }
  });
});

describe('TC-18 — logout-all', () => {
  it('revokes all three sessions and their refresh families', async () => {
    const jars = [jarFrom(await login()), jarFrom(await login()), jarFrom(await login())];

    const before = await scalar<{ n: number }>(
      `SELECT count(*)::int AS n FROM reward_portal.portal_sessions
        WHERE user_id = :userId AND status = 'active'`,
      { userId },
    );
    expect(before[0].n).toBe(3);

    await expect(mutating('post', '/api/v1/auth/logout-all', jars[0])).resolves.toMatchObject({
      status: 204,
    });

    const after = await scalar<{ n: number }>(
      `SELECT count(*)::int AS n FROM reward_portal.portal_sessions
        WHERE user_id = :userId AND status = 'active'`,
      { userId },
    );
    expect(after[0].n).toBe(0);

    const liveTokens = await scalar<{ n: number }>(
      `SELECT count(*)::int AS n FROM reward_portal.portal_refresh_tokens t
         JOIN reward_portal.portal_sessions s ON s.id = t.session_id
        WHERE s.user_id = :userId AND t.status <> 'revoked'`,
      { userId },
    );
    expect(liveTokens[0].n).toBe(0);

    for (const jar of jars) {
      await expect(http().get('/api/v1/auth/sessions').set('Cookie', jar)).resolves.toMatchObject({
        status: 401,
      });
    }
  });
});

describe('TC-22 / TC-23 — password reset against real Postgres', () => {
  it('TC-22: a reset token works exactly once', async () => {
    const token = await auth.issuePasswordReset(userId);

    await expect(
      http().post('/api/v1/auth/reset-password').send({ token, newPassword: NEW_PASSWORD }),
    ).resolves.toMatchObject({ status: 204 });

    const second = await http()
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'Another-Valid-Passphrase!9' });
    expect(second.status).toBe(400);
    expectErrorEnvelope(second.body, 'AUTH_RESET_TOKEN_INVALID');

    // The new password really is in force.
    await expect(
      http().post('/api/v1/auth/login').send({ email: EMAIL, password: NEW_PASSWORD }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('TC-23: an expired token is refused', async () => {
    const token = await auth.issuePasswordReset(userId);
    await db.query(
      `UPDATE reward_portal.portal_password_resets SET expires_at = now() - interval '1 minute'
        WHERE user_id = :userId`,
      { type: QueryTypes.UPDATE, replacements: { userId } },
    );

    await expect(
      http().post('/api/v1/auth/reset-password').send({ token, newPassword: NEW_PASSWORD }),
    ).resolves.toMatchObject({ status: 400 });
  });

  it('a policy failure rolls the consume back, leaving the link usable', async () => {
    const token = await auth.issuePasswordReset(userId);

    await expect(
      http().post('/api/v1/auth/reset-password').send({ token, newPassword: 'Password123!' }),
    ).resolves.toMatchObject({ status: 400 });

    // This is the assertion the in-memory fake cannot make: the transaction really did roll the
    // `consumed_at` write back, so a rejected password does not burn a single-use link.
    const [reset] = await scalar<{ consumed_at: Date | null }>(
      `SELECT consumed_at FROM reward_portal.portal_password_resets WHERE user_id = :userId`,
      { userId },
    );
    expect(reset.consumed_at).toBeNull();

    await expect(
      http().post('/api/v1/auth/reset-password').send({ token, newPassword: NEW_PASSWORD }),
    ).resolves.toMatchObject({ status: 204 });
  });

  it('a completed reset revokes every session and clears the lockout', async () => {
    const jar = jarFrom(await login());
    await db.query(
      `UPDATE reward_portal.portal_user_credentials
          SET failed_attempts = 5, locked_until = now() + interval '15 minutes'
        WHERE user_id = :userId`,
      { type: QueryTypes.UPDATE, replacements: { userId } },
    );

    const token = await auth.issuePasswordReset(userId);
    await expect(
      http().post('/api/v1/auth/reset-password').send({ token, newPassword: NEW_PASSWORD }),
    ).resolves.toMatchObject({ status: 204 });

    await expect(http().get('/api/v1/auth/sessions').set('Cookie', jar)).resolves.toMatchObject({
      status: 401,
    });

    const [credential] = await scalar<{ failed_attempts: number; locked_until: Date | null }>(
      `SELECT failed_attempts, locked_until FROM reward_portal.portal_user_credentials
        WHERE user_id = :userId`,
      { userId },
    );
    expect(credential).toMatchObject({ failed_attempts: 0, locked_until: null });
  });
});

describe('TC-19 / TC-20 — must_change_password against real Postgres', () => {
  it('confines the session, then releases it once the password is changed', async () => {
    await db.query(
      `UPDATE reward_portal.portal_users SET must_change_password = true WHERE id = :userId`,
      { type: QueryTypes.UPDATE, replacements: { userId } },
    );

    const response = await login();
    expect(response.body.data.mustChangePassword).toBe(true);
    const jar = jarFrom(response);

    const blocked = await http().get('/api/v1/auth/sessions').set('Cookie', jar);
    expect(blocked.status).toBe(403);
    expectErrorEnvelope(blocked.body, 'PASSWORD_CHANGE_REQUIRED');

    await expect(
      mutating('post', '/api/v1/auth/change-password', jar).send({
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }),
    ).resolves.toMatchObject({ status: 204 });

    await expect(http().get('/api/v1/auth/sessions').set('Cookie', jar)).resolves.toMatchObject({
      status: 200,
    });

    const [user] = await scalar<{ must_change_password: boolean }>(
      `SELECT must_change_password FROM reward_portal.portal_users WHERE id = :userId`,
      { userId },
    );
    expect(user.must_change_password).toBe(false);
  });
});

describe('TC-24 / TC-25 — the sessions endpoints against real Postgres', () => {
  it("returns only this user's sessions and revokes one of them", async () => {
    const keep = jarFrom(await login());
    const doomed = jarFrom(await login());

    const list = await http().get('/api/v1/auth/sessions').set('Cookie', keep);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);
    expect(JSON.stringify(list.body)).not.toMatch(/hash|secret|token/i);

    const target = list.body.data.find((entry: { current: boolean }) => !entry.current);
    await expect(
      mutating('delete', `/api/v1/auth/sessions/${target.id}`, keep),
    ).resolves.toMatchObject({ status: 204 });

    await expect(http().get('/api/v1/auth/sessions').set('Cookie', doomed)).resolves.toMatchObject({
      status: 401,
    });
  });

  it("TC-25: another user's real, live session id is 404 — and survives the attempt", async () => {
    const jar = jarFrom(await login());
    const stranger = await http()
      .post('/api/v1/auth/login')
      .send({ email: OTHER_EMAIL, password: PASSWORD });
    expect(stranger.status).toBe(200);

    const [strangerSession] = await scalar<{ id: string }>(
      `SELECT id FROM reward_portal.portal_sessions WHERE user_id = :otherUserId AND status = 'active'`,
      { otherUserId },
    );

    const response = await mutating('delete', `/api/v1/auth/sessions/${strangerSession.id}`, jar);

    // 403 would confirm the id names a real session; 404 is indistinguishable from "no such id".
    expect(response.status).toBe(404);
    expectErrorEnvelope(response.body, 'NOT_FOUND');

    const [after] = await scalar<{ status: string }>(
      `SELECT status FROM reward_portal.portal_sessions WHERE id = :id`,
      { id: strangerSession.id },
    );
    expect(after.status).toBe('active');
    await expect(
      http().get('/api/v1/auth/sessions').set('Cookie', jarFrom(stranger)),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('a malformed session id is 404 as well, never a 500 from a uuid cast', async () => {
    const jar = jarFrom(await login());

    await expect(
      mutating('delete', '/api/v1/auth/sessions/not-a-uuid', jar),
    ).resolves.toMatchObject({ status: 404 });
  });
});

describe('verification step 6 — no browser storage anywhere in the back end', () => {
  it('has zero localStorage/sessionStorage references in src (R5)', async () => {
    const { execFile } = await import('node:child_process');

    const matches = await new Promise<string>((resolve, reject) => {
      execFile(
        'grep',
        ['-rn', '-e', 'localStorage', '-e', 'sessionStorage', 'src'],
        { cwd: `${__dirname}/../..` },
        (error, stdout) => {
          // grep exits 1 when it finds nothing, which is the passing case here; only a higher
          // code is a real failure of the check itself.
          if (error !== null && error.code !== 1) reject(error);
          else resolve(stdout);
        },
      );
    });

    expect(matches).toBe('');
  });
});
