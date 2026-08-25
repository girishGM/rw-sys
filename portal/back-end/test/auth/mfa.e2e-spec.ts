/**
 * T-055 — mandatory `super_admin` MFA against the **real** Postgres instance, through the real
 * `AppModule` (and therefore through the real global guard chain, including positions 4b and 6c).
 *
 * `mfa.http.spec.ts` covers the same endpoints against in-memory stores; that is what makes 100%
 * branch coverage reachable, and it proves nothing about whether the SQL is valid Postgres,
 * whether `portal_mfa_recovery_codes` really is single-use under a unique constraint, whether the
 * pending state really leaves `portal_sessions` empty, or whether an unenrolled `super_admin` can
 * reach a route this task does not own. This file covers exactly that gap and evidences the
 * task's verification steps 1, 4 and 5.
 *
 * ### Isolation, and what cannot be cleaned up
 *
 * All fixtures are prefixed `t055-e2e` and removed in `afterAll`; recovery codes, credentials and
 * sessions cascade from the `portal_users` delete. Two deliberate exceptions, both inherited from
 * T-011's suite and both forced by the least-privilege grants in T002_008:
 *
 *  - **`portal_audit_log` rows survive.** `reward_app` holds `SELECT, INSERT` with `UPDATE`/
 *    `DELETE` revoked — that is the entire point of an append-only audit table. The rows name
 *    fixture users whose `portal_users` row is deleted, so `actor_id` becomes NULL via
 *    `ON DELETE SET NULL`.
 *  - **The encryption key rows** this file inserts are demoted and deleted in `afterAll`; the key
 *    material itself is generated per run into `process.env` and never written down (R4).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { FieldCryptoService } from '@/common/crypto/field-crypto.service';
import { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import { deletePortalUsersByEmail, insertPortalUser } from './support/portal-user-fixture';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import {
  MFA_AUDIT_EVENT,
  MFA_ERROR_CODE,
  MFA_PENDING_COOKIE_NAME,
} from '@/modules/auth/mfa.constants';
import {
  ACCESS_COOKIE_NAME,
  AUTH_ERROR_CODE,
  CSRF_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
} from '@/modules/auth/session.constants';
import { MFA_EXEMPT_KEY } from '@/modules/auth/decorators/mfa-exempt.decorator';
import { MfaPendingTokenService } from '@/modules/auth/services/mfa-pending-token.service';
import { decodeBase32, totpCodeAt } from '@/modules/auth/services/totp';
import { CSRF_HEADER_NAME } from '@/common/security/security.constants';
import { sweepOrphanedTestKeys } from '../support/encryption-keys';
import {
  MemoryThrottleStore,
  THROTTLE_STORE,
  type ThrottleCounter,
  type ThrottleStore,
} from '@/common/security/throttle.store';

jest.setTimeout(180_000);

const PASSWORD = 'correct horse battery staple 7!';
const SUPER_EMAIL = 't055-e2e-super@example.invalid';
const SECOND_SUPER_EMAIL = 't055-e2e-second-super@example.invalid';
const MAKER_EMAIL = 't055-e2e-maker@example.invalid';
const ALL_EMAILS = [SUPER_EMAIL, SECOND_SUPER_EMAIL, MAKER_EMAIL];

const KEY_PREFIX = 't055_e2e_';
const FIELD_KID = `${KEY_PREFIX}fld`;
const FIELD_ENV = 'T055_E2E_FIELD_KEY';
/** T-056 — the login lookup's HMAC key. See the insert in `beforeAll`. */
const BLIND_KID = `${KEY_PREFIX}bidx`;
const BLIND_ENV = 'T055_E2E_BLIND_KEY';

/**
 * The counter store, resettable between tests.
 *
 * Same device, and same argument, as `auth.e2e-spec.ts`'s: this file logs the same fixture user in
 * many times, and `LOGIN_PER_EMAIL_IP_LIMIT` is five per fifteen minutes. Clearing a counter
 * between tests removes a cross-test dependency; it does not lower a limit, and the limiter still
 * ships globally and is covered by its own suites. The one test that *is* about the limit
 * (TC-8) deliberately does not reset in the middle.
 */
class ResettableThrottleStore implements ThrottleStore {
  readonly kind = 'memory' as const;

  private inner = new MemoryThrottleStore();

  async consume(key: string, windowMs: number, now: number): Promise<ThrottleCounter> {
    return this.inner.consume(key, windowMs, now);
  }

  reset(): void {
    this.inner = new MemoryThrottleStore();
  }
}

const throttle = new ResettableThrottleStore();

let app: INestApplication;
let db: Sequelize;
let crypto: FieldCryptoService;
let emailCrypto: PortalUserEmailCrypto;
let pendingTokens: MfaPendingTokenService;
let superId: number;
let secondSuperId: number;
let makerId: number;
let countryId: number;
let tenantId: number;

type HttpAgent = ReturnType<typeof request>;

function http(): HttpAgent {
  return request(app.getHttpServer());
}

async function scalar<T extends object>(
  sql: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return db.query<T>(sql, { type: QueryTypes.SELECT, replacements });
}

function setCookies(response: request.Response): string[] {
  const header = response.headers['set-cookie'];
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [header];
}

function cookieNamed(response: request.Response, name: string): string | undefined {
  return setCookies(response).find((entry) => entry.startsWith(`${name}=`));
}

function cookieValue(response: request.Response, name: string): string {
  const header = cookieNamed(response, name);
  if (header === undefined) throw new Error(`no Set-Cookie for ${name}`);
  return decodeURIComponent(header.split(';')[0].slice(name.length + 1));
}

/** A `Cookie` header carrying only the cookies that were actually set (not the cleared ones). */
function jarFrom(response: request.Response): string {
  return setCookies(response)
    .map((entry) => entry.split(';')[0])
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

function csrfOf(jar: string): string | undefined {
  const pair = jar.split('; ').find((entry) => entry.startsWith(`${CSRF_COOKIE_NAME}=`));
  return pair === undefined
    ? undefined
    : decodeURIComponent(pair.slice(CSRF_COOKIE_NAME.length + 1));
}

function mutating(path: string, jar: string) {
  const pending = http().post(path).set('Cookie', jar);
  const csrf = csrfOf(jar);
  return csrf === undefined ? pending : pending.set(CSRF_HEADER_NAME, csrf);
}

async function login(email: string): Promise<request.Response> {
  return http().post('/api/v1/auth/login').send({ email, password: PASSWORD });
}

/** The seed as the user's authenticator app holds it, read out of the row. */
async function secretFor(userId: number): Promise<Buffer> {
  const [row] = await scalar<{ mfa_secret_enc: string | null }>(
    `SELECT mfa_secret_enc FROM reward_portal.portal_users WHERE id = :userId`,
    { userId },
  );
  if (row.mfa_secret_enc === null) throw new Error('no seed stored');
  return decodeBase32(
    crypto.decrypt(row.mfa_secret_enc, {
      aad: FieldCryptoService.aadFor('reward_portal.portal_users', userId),
    }),
  );
}

/** Enrols a fixture `super_admin` end to end, returning its jar and its recovery codes. */
async function enrol(
  email: string,
  userId: number,
): Promise<{
  jar: string;
  recoveryCodes: string[];
  secret: Buffer;
}> {
  const loggedIn = await login(email);
  expect(loggedIn.status).toBe(200);
  const pending = cookieValue(loggedIn, MFA_PENDING_COOKIE_NAME);

  const enrolment = await http().post('/api/v1/auth/mfa/enrol').send({ mfaPendingToken: pending });
  expect(enrolment.status).toBe(200);

  const secret = await secretFor(userId);
  const verified = await http()
    .post('/api/v1/auth/mfa/verify')
    .send({ mfaPendingToken: pending, totpCode: totpCodeAt(secret, new Date()) });
  expect(verified.status).toBe(200);

  return { jar: jarFrom(verified), recoveryCodes: verified.body.data.recoveryCodes, secret };
}

/** Resets a fixture user to "never enrolled", between tests. */
async function resetFixture(userId: number): Promise<void> {
  await db.query(
    `UPDATE reward_portal.portal_users
        SET mfa_enabled = false, mfa_secret_enc = NULL, status = 'active',
            must_change_password = false, updated_at = now()
      WHERE id = :userId`,
    { type: QueryTypes.UPDATE, replacements: { userId } },
  );
  await db.query(`DELETE FROM reward_portal.portal_mfa_recovery_codes WHERE user_id = :userId`, {
    type: QueryTypes.DELETE,
    replacements: { userId },
  });
  await db.query(`DELETE FROM reward_portal.portal_sessions WHERE user_id = :userId`, {
    type: QueryTypes.DELETE,
    replacements: { userId },
  });
  await db.query(
    `UPDATE reward_portal.portal_user_credentials
        SET failed_attempts = 0, locked_until = NULL, updated_at = now()
      WHERE user_id = :userId`,
    { type: QueryTypes.UPDATE, replacements: { userId } },
  );
}

beforeAll(async () => {
  process.env[FIELD_ENV] = randomBytes(32).toString('base64');
  process.env[BLIND_ENV] = randomBytes(32).toString('base64');

  const moduleRef = await Test.createTestingModule({
    // `DiscoveryModule` is imported only so the exempt-route inventory below can enumerate the
    // application's controllers from its own metadata rather than from a hard-coded list.
    imports: [AppModule, DiscoveryModule],
  })
    .overrideProvider(THROTTLE_STORE)
    .useValue(throttle)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  // The key row has to exist *before* `KeyRegistryService.onModuleInit` reads the table, so it is
  // inserted through a connection of its own, before `app.init()`.
  const bootstrap = moduleRef.get<Sequelize>(SEQUELIZE);

  // T-067 — drop key rows an interrupted run left behind before `app.init()` reads the whole
  // table and fails over one of them. See `test/support/encryption-keys.ts`.
  await sweepOrphanedTestKeys(bootstrap);

  await bootstrap.query(`DELETE FROM reward_portal.encryption_keys WHERE kid = :kid`, {
    type: QueryTypes.DELETE,
    replacements: { kid: FIELD_KID },
  });
  await bootstrap.query(
    `INSERT INTO reward_portal.encryption_keys (kid, purpose, algorithm, key_ref, status)
     VALUES (:kid, 'field', 'AES-256-GCM', :ref,
             CASE WHEN EXISTS (SELECT 1 FROM reward_portal.encryption_keys
                                WHERE purpose = 'field' AND status = 'active')
                  THEN 'rotating' ELSE 'active' END)`,
    { type: QueryTypes.INSERT, replacements: { kid: FIELD_KID, ref: `env:${FIELD_ENV}` } },
  );

  // T-056 added a second key purpose to the login path: `portal_users.email` is encrypted, and the
  // lookup that finds the account is an HMAC over the address, so a login now fails without an
  // active `blind_index` key just as surely as enrolment fails without a `field` one.
  await bootstrap.query(`DELETE FROM reward_portal.encryption_keys WHERE kid = :kid`, {
    type: QueryTypes.DELETE,
    replacements: { kid: BLIND_KID },
  });
  await bootstrap.query(
    `INSERT INTO reward_portal.encryption_keys (kid, purpose, algorithm, key_ref, status)
     VALUES (:kid, 'blind_index', 'HMAC-SHA256', :ref,
             CASE WHEN EXISTS (SELECT 1 FROM reward_portal.encryption_keys
                                WHERE purpose = 'blind_index' AND status = 'active')
                  THEN 'rotating' ELSE 'active' END)`,
    { type: QueryTypes.INSERT, replacements: { kid: BLIND_KID, ref: `env:${BLIND_ENV}` } },
  );

  // T-085: `app.init()` alone never binds a TCP listener, so `request(app.getHttpServer())` below
  // made supertest call `server.listen(0)`/`server.close()` itself, once per request — see
  // `test/e2e-infra/bound-http-server.e2e-spec.ts` for the reproduction. `listen(0)` binds once,
  // here, before any request runs, and already calls `init()` internally, so it both replaces and
  // satisfies the call the comment above this block still correctly describes the ordering for.
  await app.listen(0);

  db = app.get<Sequelize>(SEQUELIZE);
  crypto = app.get(FieldCryptoService);
  pendingTokens = app.get(MfaPendingTokenService);

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
  tenantId = tenant.id;

  emailCrypto = app.get(PortalUserEmailCrypto);
  await deletePortalUsersByEmail(db, emailCrypto, ALL_EMAILS);

  superId = await createUser(SUPER_EMAIL, 'super_admin');
  secondSuperId = await createUser(SECOND_SUPER_EMAIL, 'super_admin');
  makerId = await createUser(MAKER_EMAIL, 'maker');
});

async function createUser(email: string, role: 'super_admin' | 'maker'): Promise<number> {
  // `ck_portal_users_scope` makes an incorrectly-scoped user physically unstorable, so the two
  // roles get different columns rather than a shared shape.
  // T-056: inserted through the shared fixture helper so the row carries ciphertext plus a blind
  // index, exactly as the application writes it. `ck_portal_users_scope` still dictates which
  // scope columns each role may carry, hence the branch.
  const created = {
    id: await insertPortalUser(
      db,
      emailCrypto,
      role === 'super_admin'
        ? { email, displayName: 'T-055 e2e super admin', role: 'super_admin' }
        : { email, displayName: 'T-055 e2e maker', role: 'maker', countryId, tenantId },
    ),
  };

  await db.query(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    {
      type: QueryTypes.INSERT,
      replacements: { userId: created.id, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
    },
  );

  return created.id;
}

beforeEach(async () => {
  throttle.reset();
  await Promise.all([resetFixture(superId), resetFixture(secondSuperId), resetFixture(makerId)]);
});

afterAll(async () => {
  if (db !== undefined) {
    await deletePortalUsersByEmail(db, app.get(PortalUserEmailCrypto), ALL_EMAILS);
    await db.query(`DELETE FROM reward_portal.encryption_keys WHERE kid IN (:kids)`, {
      type: QueryTypes.DELETE,
      replacements: { kids: [FIELD_KID, BLIND_KID] },
    });
  }
  if (app !== undefined) await app.close();
  delete process.env[FIELD_ENV];
  delete process.env[BLIND_ENV];
});

describe('the migration T055_001 applied to the real database', () => {
  it('created portal_mfa_recovery_codes exactly as 01-DATABASE.md §2.5a specifies it', async () => {
    const columns = await scalar<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'reward_portal' AND table_name = 'portal_mfa_recovery_codes'
        ORDER BY ordinal_position`,
    );

    expect(columns.map((column) => column.column_name)).toEqual([
      'id',
      'user_id',
      'code_hash',
      'used_at',
      'created_at',
    ]);
    expect(columns.find((column) => column.column_name === 'used_at')?.is_nullable).toBe('YES');

    const [unique] = await scalar<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_indexes
        WHERE schemaname = 'reward_portal' AND indexname = 'uq_pmrc_hash'`,
    );
    expect(unique.count).toBe('1');

    const [partial] = await scalar<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'reward_portal' AND indexname = 'ix_pmrc_user_unused'`,
    );
    expect(partial.indexdef).toContain('WHERE (used_at IS NULL)');
  });

  it('registered the recovery-code digest as omit-from-logs (implementation note 8)', async () => {
    const [policy] = await scalar<{ log_treatment: string; ui_visibility: string }>(
      `SELECT log_treatment, ui_visibility FROM reward_portal.data_protection_policies
        WHERE policy_key = 'reward_portal.portal_mfa_recovery_codes.code_hash'`,
    );

    expect(policy.log_treatment).toBe('omit');
    expect(policy.ui_visibility).toBe('never');
  });
});

describe('login as a super_admin (TC-3, TC-14)', () => {
  it('TC-3: password succeeds, mfaRequired is signalled, and no session cookie is set', async () => {
    const response = await login(SUPER_EMAIL);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      role: 'super_admin',
      mustChangePassword: false,
      mfaRequired: true,
    });
    expect(cookieNamed(response, ACCESS_COOKIE_NAME)).toBeUndefined();
    expect(cookieNamed(response, REFRESH_COOKIE_NAME)).toBeUndefined();
    expect(cookieNamed(response, CSRF_COOKIE_NAME)).toBeUndefined();
    expect(cookieNamed(response, MFA_PENDING_COOKIE_NAME)).toBeDefined();
  });

  it('TC-14 / verification step 5: no portal_sessions row exists for the challenge', async () => {
    await login(SUPER_EMAIL);

    const [sessions] = await scalar<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_portal.portal_sessions WHERE user_id = :userId`,
      { userId: superId },
    );
    const [tokens] = await scalar<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_portal.portal_refresh_tokens
        WHERE user_id = :userId`,
      { userId: superId },
    );

    expect(sessions.count).toBe('0');
    expect(tokens.count).toBe('0');
  });

  it('TC-15: a country/tenant-scoped role never sees the MFA branch', async () => {
    const response = await login(MAKER_EMAIL);

    expect(response.status).toBe(200);
    expect(response.body.data.mfaRequired).toBe(false);
    expect(cookieNamed(response, ACCESS_COOKIE_NAME)).toBeDefined();
    expect(cookieNamed(response, MFA_PENDING_COOKIE_NAME)).toBeUndefined();

    const [sessions] = await scalar<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_portal.portal_sessions
        WHERE user_id = :userId AND status = 'active'`,
      { userId: makerId },
    );
    expect(sessions.count).toBe('1');
  });
});

describe('the confinement guard (TC-4, TC-5, verification step 4)', () => {
  it('TC-4: an unenrolled pending token gets 403 MFA_ENROLMENT_REQUIRED on a protected route', async () => {
    const loggedIn = await login(SUPER_EMAIL);
    const jar = jarFrom(loggedIn);

    // `/me/bootstrap` is the route the entire SPA is built on (T-015) — as good a stand-in for
    // TC-4's `GET /rules` as exists today, and it is a route this task does not own.
    const response = await http().get('/api/v1/me/bootstrap').set('Cookie', jar);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe(MFA_ERROR_CODE.ENROLMENT_REQUIRED);
  });

  it('an enrolled-but-unverified pending token gets 403 MFA_PENDING', async () => {
    await enrol(SUPER_EMAIL, superId);
    const loggedIn = await login(SUPER_EMAIL);

    const response = await http().get('/api/v1/me').set('Cookie', jarFrom(loggedIn));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe(MFA_ERROR_CODE.PENDING);
  });

  it('TC-5: the same token reaches POST /auth/mfa/enrol', async () => {
    const loggedIn = await login(SUPER_EMAIL);

    const response = await http()
      .post('/api/v1/auth/mfa/enrol')
      .set('Cookie', jarFrom(loggedIn))
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.data.secret).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('the exempt list is exactly the four routes implementation note 4 names', () => {
    // Every route carrying `@AllowWhileMfaPending()` is reachable with **half** a credential, so
    // the list is inventoried from the running application's own metadata rather than trusted.
    // A fifth entry appearing here is a security decision that must be made deliberately; this
    // assertion is what stops one being made by accident.
    const exempt = new Set<string>();

    for (const wrapper of app.get(DiscoveryService).getControllers()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (instance === undefined || instance === null) continue;

      const metatype = wrapper.metatype as object | undefined;
      if (metatype === undefined) continue;

      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      const controllerPath = Reflect.getMetadata(PATH_METADATA, metatype) ?? '';
      // The decorator is read handler-then-class by `isMfaExempt`, so the inventory has to look
      // in both places — `MfaController` carries it on the class, `AuthController.logout` on the
      // method.
      const classExempt = Reflect.getMetadata(MFA_EXEMPT_KEY, metatype) === true;

      for (const name of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[name];
        if (typeof handler !== 'function' || name === 'constructor') continue;

        const routePath = Reflect.getMetadata(PATH_METADATA, handler);
        // Not a route method at all (a private helper on the controller).
        if (routePath === undefined) continue;
        if (!classExempt && Reflect.getMetadata(MFA_EXEMPT_KEY, handler) !== true) continue;

        exempt.add(`/${controllerPath}/${routePath}`.replace(/\/+/g, '/').replace(/\/$/, ''));
      }
    }

    expect([...exempt].sort()).toEqual([
      '/auth/logout',
      '/auth/mfa/enrol',
      '/auth/mfa/recover',
      '/auth/mfa/verify',
    ]);
  });
});

describe('enrolment and verification (TC-1, TC-2, TC-6, TC-7)', () => {
  it('TC-1: enrolling flips mfa_enabled and stores ten hashed recovery codes', async () => {
    const { recoveryCodes } = await enrol(SUPER_EMAIL, superId);

    const [user] = await scalar<{ mfa_enabled: boolean; mfa_secret_enc: string }>(
      `SELECT mfa_enabled, mfa_secret_enc FROM reward_portal.portal_users WHERE id = :userId`,
      { userId: superId },
    );
    expect(user.mfa_enabled).toBe(true);
    // Encrypted at rest through T-016, never plaintext base32.
    expect(user.mfa_secret_enc.startsWith('v1.')).toBe(true);

    const codes = await scalar<{ code_hash: string; used_at: Date | null }>(
      `SELECT code_hash, used_at FROM reward_portal.portal_mfa_recovery_codes
        WHERE user_id = :userId ORDER BY id`,
      { userId: superId },
    );
    expect(recoveryCodes).toHaveLength(10);
    expect(codes).toHaveLength(10);
    expect(codes.every((code) => code.used_at === null)).toBe(true);
    // Digests only — no printed code appears anywhere in the table.
    for (const code of recoveryCodes) {
      expect(codes.some((row) => row.code_hash === code)).toBe(false);
      expect(codes.every((row) => /^[0-9a-f]{64}$/.test(row.code_hash))).toBe(true);
    }
  });

  it('TC-6: a correct code sets all three session cookies and creates one session', async () => {
    const { jar } = await enrol(SUPER_EMAIL, superId);

    expect(jar).toContain(ACCESS_COOKIE_NAME);
    expect(jar).toContain(REFRESH_COOKIE_NAME);
    expect(jar).toContain(CSRF_COOKIE_NAME);

    const [sessions] = await scalar<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_portal.portal_sessions
        WHERE user_id = :userId AND status = 'active'`,
      { userId: superId },
    );
    expect(sessions.count).toBe('1');

    // And the session actually works on a protected route, which is the whole point.
    const bootstrap = await http().get('/api/v1/me').set('Cookie', jar);
    expect(bootstrap.status).toBe(200);
  });

  it('TC-2: the seed is not shown a second time', async () => {
    await enrol(SUPER_EMAIL, superId);
    const loggedIn = await login(SUPER_EMAIL);

    const response = await http()
      .post('/api/v1/auth/mfa/enrol')
      .set('Cookie', jarFrom(loggedIn))
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe(MFA_ERROR_CODE.ALREADY_ENROLLED);
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('TC-7: a wrong code is a generic 401 and creates no session', async () => {
    await enrol(SUPER_EMAIL, superId);
    await db.query(`DELETE FROM reward_portal.portal_sessions WHERE user_id = :userId`, {
      type: QueryTypes.DELETE,
      replacements: { userId: superId },
    });

    const loggedIn = await login(SUPER_EMAIL);
    const response = await http()
      .post('/api/v1/auth/mfa/verify')
      .set('Cookie', jarFrom(loggedIn))
      .send({ totpCode: '000000' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe(AUTH_ERROR_CODE.INVALID_CREDENTIALS);

    const [sessions] = await scalar<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_portal.portal_sessions WHERE user_id = :userId`,
      { userId: superId },
    );
    expect(sessions.count).toBe('0');
  });

  it('TC-9/TC-10: one step of skew is accepted, three is not', async () => {
    const { secret } = await enrol(SUPER_EMAIL, superId);
    const step = 30_000;

    const stale = await login(SUPER_EMAIL);
    const rejected = await http()
      .post('/api/v1/auth/mfa/verify')
      .set('Cookie', jarFrom(stale))
      .send({ totpCode: totpCodeAt(secret, new Date(Date.now() - 3 * step)) });
    expect(rejected.status).toBe(401);

    const fresh = await login(SUPER_EMAIL);
    const accepted = await http()
      .post('/api/v1/auth/mfa/verify')
      .set('Cookie', jarFrom(fresh))
      .send({ totpCode: totpCodeAt(secret, new Date(Date.now() - step)) });
    expect(accepted.status).toBe(200);
  });

  it('TC-13: a pending token older than five minutes is refused', async () => {
    const expired = pendingTokens.mint(
      { userId: superId, enrolled: false },
      new Date(Date.now() - 6 * 60 * 1000),
    );

    const response = await http().post('/api/v1/auth/mfa/enrol').send({ mfaPendingToken: expired });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe(AUTH_ERROR_CODE.SESSION_INVALID);
  });
});

describe('recovery codes (TC-11, TC-12)', () => {
  it('TC-11: a valid code logs in and sets used_at on exactly that row', async () => {
    const { recoveryCodes } = await enrol(SUPER_EMAIL, superId);
    const loggedIn = await login(SUPER_EMAIL);

    const response = await http()
      .post('/api/v1/auth/mfa/recover')
      .set('Cookie', jarFrom(loggedIn))
      .send({ recoveryCode: recoveryCodes[0] });

    expect(response.status).toBe(200);
    expect(response.body.data.recoveryCodesRemaining).toBe(9);
    expect(cookieNamed(response, ACCESS_COOKIE_NAME)).toBeDefined();

    const [used] = await scalar<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_portal.portal_mfa_recovery_codes
        WHERE user_id = :userId AND used_at IS NOT NULL`,
      { userId: superId },
    );
    expect(used.count).toBe('1');
  });

  it('TC-12: reusing a code is rejected and recorded in portal_audit_log', async () => {
    const { recoveryCodes } = await enrol(SUPER_EMAIL, superId);
    const first = await login(SUPER_EMAIL);
    await http()
      .post('/api/v1/auth/mfa/recover')
      .set('Cookie', jarFrom(first))
      .send({ recoveryCode: recoveryCodes[0] });

    const second = await login(SUPER_EMAIL);
    const reuse = await http()
      .post('/api/v1/auth/mfa/recover')
      .set('Cookie', jarFrom(second))
      .send({ recoveryCode: recoveryCodes[0] });

    expect(reuse.status).toBe(401);

    const audit = await scalar<{ event_type: string; detail: Record<string, unknown> }>(
      `SELECT event_type, detail FROM reward_portal.portal_audit_log
        WHERE actor_id = :userId AND event_type = :event
        ORDER BY id DESC LIMIT 1`,
      { userId: superId, event: MFA_AUDIT_EVENT.RECOVERY_REUSE },
    );
    expect(audit).toHaveLength(1);
    // The row is auditable, and the presented code is nowhere in it.
    expect(JSON.stringify(audit[0].detail)).not.toContain(recoveryCodes[0]);

    // The row survives as evidence — never deleted (01-DATABASE.md §2.5a).
    const [rows] = await scalar<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_portal.portal_mfa_recovery_codes
        WHERE user_id = :userId`,
      { userId: superId },
    );
    expect(rows.count).toBe('10');
  });
});

describe('rate limiting (TC-8)', () => {
  it('sheds the sixth wrong code within the window with 429', async () => {
    await enrol(SUPER_EMAIL, superId);
    throttle.reset();
    const loggedIn = await login(SUPER_EMAIL);
    const pending = cookieValue(loggedIn, MFA_PENDING_COOKIE_NAME);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await http()
        .post('/api/v1/auth/mfa/verify')
        .send({ mfaPendingToken: pending, totpCode: '000000' });
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });
});

describe('administrative reset (TC-16, TC-17)', () => {
  it('TC-17: another super_admin resets the target, and the target must re-enrol', async () => {
    const actor = await enrol(SUPER_EMAIL, superId);
    await enrol(SECOND_SUPER_EMAIL, secondSuperId);

    const response = await mutating(
      `/api/v1/admin/access-control/super-admins/${secondSuperId}/mfa-reset`,
      actor.jar,
    ).send({});

    expect(response.status).toBe(204);

    const [target] = await scalar<{ mfa_enabled: boolean; mfa_secret_enc: string | null }>(
      `SELECT mfa_enabled, mfa_secret_enc FROM reward_portal.portal_users WHERE id = :userId`,
      { userId: secondSuperId },
    );
    expect(target.mfa_enabled).toBe(false);
    expect(target.mfa_secret_enc).toBeNull();

    const [live] = await scalar<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_portal.portal_sessions
        WHERE user_id = :userId AND status = 'active'`,
      { userId: secondSuperId },
    );
    expect(live.count).toBe('0');

    const [unusedCodes] = await scalar<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_portal.portal_mfa_recovery_codes
        WHERE user_id = :userId AND used_at IS NULL`,
      { userId: secondSuperId },
    );
    expect(unusedCodes.count).toBe('0');

    const audit = await scalar<{ actor_id: number; target_id: string }>(
      `SELECT actor_id, target_id FROM reward_portal.portal_audit_log
        WHERE event_type = :event AND target_id = :target
        ORDER BY id DESC LIMIT 1`,
      { event: MFA_AUDIT_EVENT.RESET_BY_ADMIN, target: String(secondSuperId) },
    );
    expect(audit[0].actor_id).toBe(superId);

    // ...and the next login puts them back into the enrolment flow, not into a session.
    const relogin = await login(SECOND_SUPER_EMAIL);
    expect(relogin.body.data.mfaRequired).toBe(true);
    expect(cookieNamed(relogin, ACCESS_COOKIE_NAME)).toBeUndefined();
    const confined = await http().get('/api/v1/me').set('Cookie', jarFrom(relogin));
    expect(confined.status).toBe(403);
    expect(confined.body.error.code).toBe(MFA_ERROR_CODE.ENROLMENT_REQUIRED);
  });

  it('TC-16: a super_admin whose own MFA is unsatisfied cannot reset anybody', async () => {
    await enrol(SECOND_SUPER_EMAIL, secondSuperId);
    // The unenrolled actor has no session at all — which is the strongest form of the denial.
    const loggedIn = await login(SUPER_EMAIL);

    const response = await mutating(
      `/api/v1/admin/access-control/super-admins/${secondSuperId}/mfa-reset`,
      jarFrom(loggedIn),
    ).send({});

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe(MFA_ERROR_CODE.ENROLMENT_REQUIRED);

    const [target] = await scalar<{ mfa_enabled: boolean }>(
      `SELECT mfa_enabled FROM reward_portal.portal_users WHERE id = :userId`,
      { userId: secondSuperId },
    );
    expect(target.mfa_enabled).toBe(true);
  });

  it('a non-super_admin cannot reach the reset endpoint at all (R6)', async () => {
    const makerLogin = await login(MAKER_EMAIL);
    const jar = jarFrom(makerLogin);

    const response = await mutating(
      `/api/v1/admin/access-control/super-admins/${secondSuperId}/mfa-reset`,
      jar,
    ).send({});

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('PERM_DENIED');
  });

  it('answers 404 for a target that is not a super_admin, disclosing nothing', async () => {
    const actor = await enrol(SUPER_EMAIL, superId);

    const response = await mutating(
      `/api/v1/admin/access-control/super-admins/${makerId}/mfa-reset`,
      actor.jar,
    ).send({});

    expect(response.status).toBe(404);
  });
});

describe('TC-19: nothing secret reaches a log or a response', () => {
  it('keeps the seed and the recovery-code digests out of every response body', async () => {
    const { recoveryCodes } = await enrol(SUPER_EMAIL, superId);
    const [user] = await scalar<{ mfa_secret_enc: string }>(
      `SELECT mfa_secret_enc FROM reward_portal.portal_users WHERE id = :userId`,
      { userId: superId },
    );

    const loggedIn = await login(SUPER_EMAIL);
    const recovered = await http()
      .post('/api/v1/auth/mfa/recover')
      .set('Cookie', jarFrom(loggedIn))
      .send({ recoveryCode: recoveryCodes[0] });

    const bodies = [loggedIn.body, recovered.body].map((body) => JSON.stringify(body));
    for (const body of bodies) {
      expect(body).not.toContain(user.mfa_secret_enc);
      expect(body).not.toContain(recoveryCodes[0]);
      expect(body).not.toContain('mfa_secret_enc');
    }
  });

  it('never writes a plaintext seed or a code into portal_audit_log', async () => {
    const { recoveryCodes, secret } = await enrol(SUPER_EMAIL, superId);
    const base32Seed = secret.toString('base64');

    const rows = await scalar<{ detail: unknown }>(
      `SELECT detail FROM reward_portal.portal_audit_log
        WHERE actor_id = :userId ORDER BY id DESC LIMIT 50`,
      { userId: superId },
    );

    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain(base32Seed);
    for (const code of recoveryCodes) expect(serialised).not.toContain(code);
  });
});
