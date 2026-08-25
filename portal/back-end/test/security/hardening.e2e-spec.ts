/**
 * T-012 — the hardening layer against the **real** `AppModule`, the real Postgres instance and
 * the real `main.ts` composition.
 *
 * ### Why this exists alongside the unit specs in this folder
 *
 * The specs beside this one pin behaviour: what the CSP string contains, what the guard does
 * when a counter store rejects, that 1201 login attempts trip the ceiling. They build purpose-
 * made applications to do it, and that is what makes 100% branch coverage and a 1200-request
 * test reachable at all.
 *
 * None of that proves the controls are actually *installed*. A perfectly correct
 * `configureHttpSecurity` that `main.ts` never calls, a `CsrfGuard` that is registered but not
 * global, a header set that a later middleware overwrites — every one of those passes the unit
 * suite and ships an unprotected API. This file is the wiring check: it boots what production
 * boots and asserts the controls reach the wire.
 *
 * Evidences TC-1, TC-2, TC-3, TC-4, TC-5, TC-7, TC-8, TC-9, TC-10, TC-16, TC-18, TC-19, TC-20
 * and TC-21, and verification steps 1–4 and 6–7 of the task file.
 *
 * ### Isolation
 *
 * One fixture user, prefixed `t012-e2e`, deleted in `afterAll` — the same pattern, and the same
 * two unavoidable exceptions (append-only `portal_audit_log` rows survive; `reward_config` rows
 * are soft-deleted because `reward_app` holds no DELETE there), as `auth.e2e-spec.ts` documents
 * at length.
 *
 * The counter store is overridden with a switchable double. Not to weaken anything — the guard,
 * the policy and the limits are all the real ones — but because a rate limiter shared by an
 * entire test file is a test file whose 61st request fails for reasons that have nothing to do
 * with what it was asserting. It also makes "Redis is down" (TC-20/TC-21) a thing this suite can
 * cause on demand, which no real store obligingly does.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { CredentialService } from '@/modules/auth/services/credential.service';
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
import { asExpressApplication, configureHttpSecurity } from '@/common/security/security.middleware';
import { HSTS_HEADER_VALUE } from '@/common/security/security.constants';
import { FORBIDDEN_CSP_TOKENS } from './support/csp-tokens';
import {
  MemoryThrottleStore,
  THROTTLE_STORE,
  ThrottleStoreUnavailableError,
  type ThrottleCounter,
  type ThrottleStore,
} from '@/common/security/throttle.store';
import { collectRoutes, findMutatingGetHandlers } from './support/route-inventory';
// T-014 — `ErrorNormalizationFilter` now adds `message` and `traceId` to every error body, as
// this module's own `security.exceptions.ts` header predicted. See
// `test/common/support/error-envelope.ts`; the replacement assertion is stricter, not looser —
// TC-15's "the 429 discloses nothing about which limit tripped" still holds.
import { expectErrorEnvelope } from '../common/support/error-envelope';
// T-056 — fixtures carry ciphertext plus a blind index; see that helper's header.
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import { bindTestServer } from './support/bound-app';

jest.setTimeout(180_000);

const EMAIL = 't012-e2e-operator@example.invalid';
const PASSWORD = 'correct horse battery staple 7!';
const ALLOWED_ORIGIN = 'https://portal.t012.example.test';
const EVIL_ORIGIN = 'https://evil.com';

/**
 * A store whose backing implementation can be swapped mid-suite, so an outage is something the
 * test causes rather than something it waits for.
 */
class SwitchableThrottleStore implements ThrottleStore {
  readonly kind = 'memory' as const;
  private delegate = new MemoryThrottleStore();
  failing = false;

  async consume(key: string, windowMs: number, now: number): Promise<ThrottleCounter> {
    if (this.failing) throw new ThrottleStoreUnavailableError('ECONNREFUSED (simulated)');
    return this.delegate.consume(key, windowMs, now);
  }

  reset(): void {
    this.delegate = new MemoryThrottleStore();
    this.failing = false;
  }
}

/** Namespaces this suite's encryption-key rows. */
const T056_SUITE = 't012sec';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;
let store: SwitchableThrottleStore;
let userId: number;

type HttpAgent = ReturnType<typeof request>;

/** Set once in `beforeAll` by `bindTestServer` — see that helper for why this is not
 *  `request(app.getHttpServer())`. */
let baseUrl: string;

function http(): HttpAgent {
  return request(baseUrl);
}

function setCookieHeaders(response: request.Response): string[] {
  const header = response.headers['set-cookie'];
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [header];
}

/** The `Cookie` header a browser would send back, from a login response's `Set-Cookie`s. */
function cookieJar(response: request.Response): string {
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

async function login(): Promise<request.Response> {
  const response = await http()
    .post('/api/v1/auth/login')
    .send({ email: EMAIL, password: PASSWORD });
  expect(response.status).toBe(200);
  return response;
}

beforeAll(async () => {
  // Set before the module is compiled: `ConfigModule` validates and freezes the environment as
  // it is instantiated, and `dotenv` never overwrites a variable already in `process.env`.
  process.env.CORS_ALLOWED_ORIGINS = ALLOWED_ORIGIN;
  process.env.API_ORIGIN = 'https://api.t012.example.test';

  store = new SwitchableThrottleStore();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(THROTTLE_STORE)
    .useValue(store)
    .compile();

  // T-056: `portal_users.email` is encrypted, so the login this suite performs needs an active
  // `field` and `blind_index` key. Provisioned before `app.init()` — the registry reads once.
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), T056_SUITE);

  app = moduleRef.createNestApplication<NestExpressApplication>();
  // Identical to main.ts, in the same order — that is the point of this file.
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  configureHttpSecurity(asExpressApplication(app), {
    apiOrigin: process.env.API_ORIGIN,
    corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS,
    trustProxy: undefined,
    enforceHttps: false,
  });
  baseUrl = await bindTestServer(app);

  db = app.get<Sequelize>(SEQUELIZE);

  const [country] = await db.query<{ id: number }>(
    `SELECT id FROM reward_config.countries ORDER BY id LIMIT 1`,
    { type: QueryTypes.SELECT },
  );
  const [tenant] = await db.query<{ id: number }>(
    `SELECT id FROM reward_config.tenants WHERE deleted_at IS NULL ORDER BY id LIMIT 1`,
    { type: QueryTypes.SELECT },
  );
  if (country === undefined || tenant === undefined) {
    throw new Error('no country/tenant row to build a fixture user on');
  }

  emailCrypto = emailCryptoOf(app);
  await deletePortalUsersByEmail(db, emailCrypto, [EMAIL]);

  userId = await insertPortalUser(db, emailCrypto, {
    email: EMAIL,
    displayName: 'T-012 e2e operator',
    role: 'maker',
    countryId: country.id,
    tenantId: tenant.id,
  });

  await db.query(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    {
      type: QueryTypes.INSERT,
      replacements: { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
    },
  );
});

afterAll(async () => {
  if (db !== undefined) {
    await deletePortalUsersByEmail(db, emailCrypto, [EMAIL]);
    await removeEncryptionKeys(db, T056_SUITE);
  }
  if (app !== undefined) await app.close();
  delete process.env.CORS_ALLOWED_ORIGINS;
  delete process.env.API_ORIGIN;
});

beforeEach(() => {
  store.reset();
});

describe('response headers on the real application', () => {
  it('TC-1: GET /health carries the whole §7 header set', async () => {
    const response = await http().get('/api/v1/health').expect(200);

    expect(response.headers['content-security-policy']).toBeDefined();
    expect(response.headers['strict-transport-security']).toBe(HSTS_HEADER_VALUE);
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('TC-2: X-Powered-By is absent', async () => {
    const response = await http().get('/api/v1/health').expect(200);
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('TC-3: the CSP locks framing and objects down and permits no unsafe script source', async () => {
    const csp = (await http().get('/api/v1/health').expect(200)).headers[
      'content-security-policy'
    ] as string;

    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("script-src 'self'");
    for (const token of FORBIDDEN_CSP_TOKENS) {
      expect(csp).not.toContain(token);
    }
  });

  it('TC-19: GET /health returns exactly {"status":"ok"} and nothing else', async () => {
    const response = await http().get('/api/v1/health').expect(200);

    expect(response.body).toEqual({ status: 'ok' });
    expect(Object.keys(response.body)).toEqual(['status']);
    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toMatch(/version|schema|database|dependenc|uptime|commit/i);
  });

  it('sets the headers on an error response too, not just a successful one', async () => {
    const response = await http().get('/api/v1/does-not-exist').expect(404);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('CORS on the real application', () => {
  it('TC-4: a preflight from the allowed origin echoes it with credentials', async () => {
    const response = await http()
      .options('/api/v1/auth/login')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'X-CSRF-Token');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('TC-5: a preflight from https://evil.com gets no Access-Control-Allow-Origin', async () => {
    const response = await http()
      .options('/api/v1/auth/login')
      .set('Origin', EVIL_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('CSRF on the real /auth/logout', () => {
  it('TC-9: a session with the matching token logs out successfully', async () => {
    const session = await login();

    await http()
      .post('/api/v1/auth/logout')
      .set('Cookie', cookieJar(session))
      .set('X-CSRF-Token', csrfFrom(session))
      .expect(204);
  });

  it('TC-7: the same request with no X-CSRF-Token is 403 CSRF_TOKEN_MISSING', async () => {
    const session = await login();

    const response = await http()
      .post('/api/v1/auth/logout')
      .set('Cookie', cookieJar(session))
      .expect(403);

    expectErrorEnvelope(response.body, 'CSRF_TOKEN_MISSING');
  });

  it('TC-8: a mismatched token is 403 CSRF_TOKEN_INVALID', async () => {
    const session = await login();

    const response = await http()
      .post('/api/v1/auth/logout')
      .set('Cookie', cookieJar(session))
      .set('X-CSRF-Token', 'a-token-from-somewhere-else')
      .expect(403);

    expectErrorEnvelope(response.body, 'CSRF_TOKEN_INVALID');
  });

  it('TC-10: a GET with a session and no CSRF token is allowed through', async () => {
    const session = await login();

    const response = await http()
      .get('/api/v1/auth/sessions')
      .set('Cookie', cookieJar(session))
      .expect(200);

    expect(response.body.data).toBeDefined();
  });

  it('rejects before the handler runs — the session survives a CSRF failure', async () => {
    const session = await login();

    await http().post('/api/v1/auth/logout').set('Cookie', cookieJar(session)).expect(403);

    // If the guard had run after the handler, this session would already be revoked.
    await http().get('/api/v1/auth/sessions').set('Cookie', cookieJar(session)).expect(200);
  });
});

describe('request shape', () => {
  it('TC-16: a 2 MB body is 413, in the documented envelope', async () => {
    const response = await http()
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: EMAIL, password: 'x'.repeat(2 * 1024 * 1024) }))
      .expect(413);

    expect(response.body).toEqual({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  });
});

describe('TC-18: no @Get() handler mutates state', () => {
  it('finds no mutating GET handler anywhere in the built application', () => {
    const routes = collectRoutes(app);

    // Guards against the scan silently reading an empty container and passing vacuously.
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.some((route) => route.method === 'GET')).toBe(true);

    expect(findMutatingGetHandlers(routes)).toEqual([]);
  });
});

describe('AR-11: the counter store fails asymmetrically (TC-20, TC-21)', () => {
  it('TC-20: login is shed with 503 and never reaches Argon2', async () => {
    const credentials = app.get(CredentialService);
    const authenticate = jest.spyOn(credentials, 'authenticate');

    store.failing = true;

    const response = await http()
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD });

    expect(response.status).toBe(503);
    expectErrorEnvelope(response.body, 'SERVICE_UNAVAILABLE');
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    // The whole point of failing closed here: no Argon2 verify, no credential store read.
    expect(authenticate).not.toHaveBeenCalled();

    authenticate.mockRestore();
  });

  it('TC-20: refresh is shed the same way', async () => {
    store.failing = true;

    const response = await http().post('/api/v1/auth/refresh');

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBeDefined();
  });

  it('TC-21: an authenticated non-auth call still succeeds — a Redis outage is not an outage', async () => {
    const session = await login();

    store.failing = true;

    const response = await http()
      .get('/api/v1/auth/sessions')
      .set('Cookie', cookieJar(session))
      .expect(200);

    expect(response.body.data).toBeDefined();
  });

  it('recovers as soon as the store does', async () => {
    store.failing = true;
    await http().post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD }).expect(503);

    store.failing = false;
    await login();
  });
});

describe('the application wires the real store when nothing overrides it', () => {
  it('resolves an in-memory store from the real module graph', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const resolved = moduleRef.get<ThrottleStore>(THROTTLE_STORE);

    // No REDIS_URL in the local environment, so memory is correct — and, importantly, it is a
    // real store rather than a no-op: `kind` is what the boot log reports to an operator.
    expect(resolved.kind).toBe('memory');

    await moduleRef.close();
  });
});
