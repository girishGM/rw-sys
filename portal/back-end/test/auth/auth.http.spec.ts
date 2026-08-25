/**
 * T-011 — `/auth/*` over real HTTP, with in-memory stores behind it.
 *
 * ### Why this exists alongside `auth.e2e-spec.ts`
 *
 * The e2e suite runs the same endpoints against real Postgres and is the authority on anything
 * transactional — `FOR UPDATE` serialising two replays, a rollback leaving a reset token usable.
 * It cannot, however, be the authority on *coverage*: it runs under a different Jest config, and
 * it cannot force a store to fail on demand.
 *
 * This file is where the HTTP surface itself is pinned: the exact `Set-Cookie` attributes, the
 * exact 401/403/404 bodies, the guard chain's behaviour on a route outside `AuthModule`, and the
 * recursive "no secret at any depth" scan of every response. Those are properties of the
 * controller and the guards, not of the database, and they are asserted here against a real Nest
 * HTTP server with the same global `ValidationPipe` `main.ts` installs.
 *
 * TC-1…TC-5, TC-7…TC-11, TC-14, TC-16…TC-21, TC-24…TC-26 all have their form here.
 */
import { Controller, Get, INestApplication, UseGuards, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

jest.mock('@/database/database.module', () => jest.requireActual('./support/fake-database.module'));
jest.mock('@/config/config.module', () => jest.requireActual('./support/fake-config.module'));

import { AuthModule } from '@/modules/auth/auth.module';
import { AuthController, requestContext } from '@/modules/auth/auth.controller';
import { CREDENTIAL_STORE } from '@/modules/auth/services/credential.repository';
import { SESSION_STORE } from '@/modules/auth/services/session.repository';
import { CredentialService } from '@/modules/auth/services/credential.service';
import { SessionService } from '@/modules/auth/services/session.service';
import { TokenService } from '@/modules/auth/services/token.service';
import { AuthService } from '@/modules/auth/auth.service';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { PasswordChangeRequiredGuard } from '@/modules/auth/guards/password-change-required.guard';
import { SessionValidGuard } from '@/modules/auth/guards/session-valid.guard';
import {
  ACCESS_COOKIE_NAME,
  ACCESS_TOKEN_TTL_SECONDS,
  CSRF_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_TTL_SECONDS,
} from '@/modules/auth/session.constants';
import { bindTestServer } from '../security/support/bound-app';
import { FakeCredentialStore } from './support/fake-credential-store';
import { FakeSessionStore } from './support/fake-session-store';
import { generateForeignKeyPair } from './support/test-keys';
// T-086 — the load-robust statistic behind TC-21's timing half. See `timing-budget.ts`.
import { describeTrials, measureUntilClean, type TimingSamples } from './timing-budget';

jest.setTimeout(120_000);

const PASSWORD = 'correct horse battery staple 7!';
const NEW_PASSWORD = 'Tr0ubador-Zephyr-Quill!42';
const EMAIL = 'operator@example.com';

/**
 * A controller *outside* `AuthModule` wearing the same three guards.
 *
 * TC-7, TC-8, TC-14, TC-16, TC-17 and TC-19 are all phrased against `GET /me` or
 * `GET /campaigns` — routes owned by T-015 and T-031 respectively, neither of which exists yet.
 * Standing them up here as probes tests exactly what those test cases are about (the guard chain
 * applied to an ordinary business route) without this task reaching into another task's files.
 */
@Controller()
@UseGuards(JwtAuthGuard, SessionValidGuard, PasswordChangeRequiredGuard)
class ProbeController {
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): unknown {
    return { data: { userId: user.userId, role: user.role, tenantId: user.tenantId } };
  }

  @Get('campaigns')
  campaigns(): unknown {
    return { data: [] };
  }
}

type HttpAgent = ReturnType<typeof request>;

interface Harness {
  app: INestApplication;
  http: () => HttpAgent;
  credentialStore: FakeCredentialStore;
  sessionStore: FakeSessionStore;
  tokens: TokenService;
  sessions: SessionService;
  auth: AuthService;
}

async function buildHarness(): Promise<Harness> {
  const credentialStore = new FakeCredentialStore();
  const sessionStore = new FakeSessionStore();

  const moduleRef = await Test.createTestingModule({
    imports: [AuthModule],
    controllers: [ProbeController],
  })
    .overrideProvider(CREDENTIAL_STORE)
    .useValue(credentialStore)
    .overrideProvider(SESSION_STORE)
    .useValue(sessionStore)
    .compile();

  const app = moduleRef.createNestApplication();
  // Mirrors main.ts exactly — the pipe is what makes `forbidNonWhitelisted` a real control.
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();
  // T-087: bind **once** and aim supertest at the resulting base URL. Handing `request()` a
  // non-listening server makes superagent `listen(0)`/`close()` it *per request*, and the port it
  // froze into the URL at construction time can be rebound by another listener before the socket
  // connects — so the reply can come from a different server entirely. That misroute is
  // direction-agnostic: it invented this suite's "cookie-less refresh answered 200", which reads
  // exactly like an auth bypass. See `bound-app.ts` and the T-087 report.
  const base = await bindTestServer(app);

  return {
    app,
    http: () => request(base),
    credentialStore,
    sessionStore,
    tokens: app.get(TokenService),
    sessions: app.get(SessionService),
    auth: app.get(AuthService),
  };
}

/**
 * Seeds one account into **both** fake stores with a real Argon2 hash, keeping the two ids
 * aligned — see `FakeSessionStore.seedUser` for why that alignment is load-bearing.
 */
async function seedAccount(
  harness: Harness,
  overrides: Record<string, unknown> = {},
): Promise<{ id: number; email: string }> {
  const credentials = harness.app.get(CredentialService);
  const user = harness.credentialStore.seedUser({
    email: EMAIL,
    countryId: 1,
    tenantId: 7,
    ...overrides,
  });
  harness.credentialStore.seedCredential(user.id, await credentials.hash(PASSWORD));
  harness.sessionStore.seedUser(user);
  return { id: user.id, email: user.email };
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

/** Builds a `Cookie` request header from a login/refresh response. */
function jarFrom(response: request.Response): string {
  return setCookies(response)
    .map((entry) => entry.split(';')[0])
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

async function loginOk(harness: Harness): Promise<request.Response> {
  const response = await harness
    .http()
    .post('/api/v1/auth/login')
    .send({ email: EMAIL, password: PASSWORD });
  expect(response.status).toBe(200);
  return response;
}

/**
 * TC-26 — walks a response body and returns every key that looks like secret material.
 *
 * `mustChangePassword` is the single allowed exception, and only as a boolean: TC-5 and
 * 02-SECURITY.md §2 both require that field in the login body, while TC-26 as literally written
 * forbids any key matching `/password/i`. The conflict, and this resolution, are recorded in the
 * completion report. Allowing the *name* but pinning the *type* means a later refactor cannot
 * quietly widen the exemption into a string.
 */
function secretLookingKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => secretLookingKeys(entry, `${path}[${index}]`));
  }
  if (value === null || typeof value !== 'object') return [];

  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const here = path === '' ? key : `${path}.${key}`;
    if (/hash|secret|token|password/i.test(key)) {
      if (key === 'mustChangePassword' && typeof child === 'boolean') {
        // allowed, and only as a boolean
      } else {
        found.push(here);
      }
    }
    found.push(...secretLookingKeys(child, here));
  }
  return found;
}

describe('POST /auth/login', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
    await seedAccount(harness);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('TC-1: sets exactly three cookies', async () => {
    const response = await loginOk(harness);

    expect(setCookies(response)).toHaveLength(3);
    expect(cookieNamed(response, ACCESS_COOKIE_NAME)).toBeDefined();
    expect(cookieNamed(response, REFRESH_COOKIE_NAME)).toBeDefined();
    expect(cookieNamed(response, CSRF_COOKIE_NAME)).toBeDefined();
  });

  it('TC-2: __Host-rs_at is HttpOnly, Secure, SameSite=Strict, Path=/', async () => {
    const response = await loginOk(harness);
    const cookie = cookieNamed(response, ACCESS_COOKIE_NAME);

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/;');
    expect(cookie).toContain(`Max-Age=${ACCESS_TOKEN_TTL_SECONDS}`);
    expect(cookie).not.toMatch(/domain=/i);
  });

  it('TC-3: __Host-rs_rt is Path=/ (the prefix requires it) and lives seven days', async () => {
    const cookie = cookieNamed(await loginOk(harness), REFRESH_COOKIE_NAME);

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    // T-058: `Path=/`, not `/api/v1/auth`. A `__Host-` cookie with a narrower path is rejected
    // by the browser and never stored, which killed every session at the 15-minute mark.
    expect(cookie).toContain('Path=/;');
    expect(cookie).not.toContain('Path=/api/v1/auth');
    expect(cookie).not.toMatch(/domain=/i);
    expect(cookie).toContain(`Max-Age=${REFRESH_TOKEN_TTL_SECONDS}`);
  });

  it('TC-4: rs_csrf is Secure and SameSite=Strict but readable by JavaScript', async () => {
    const cookie = cookieNamed(await loginOk(harness), CSRF_COOKIE_NAME);

    expect(cookie).not.toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('TC-5: the body carries no token and no hash — only role and mustChangePassword', async () => {
    const response = await loginOk(harness);

    expect(response.body).toEqual({
      data: { role: 'maker', mustChangePassword: false, mfaRequired: false },
    });
    expect(secretLookingKeys(response.body)).toEqual([]);
    // And emphatically not the access token that just went out in a header.
    expect(JSON.stringify(response.body)).not.toContain(cookieValue(response, ACCESS_COOKIE_NAME));
  });

  it('TC-6: unknown email, wrong password and an inactive account give a byte-identical 401', async () => {
    await seedAccount(harness, { email: 'inactive@example.com', status: 'inactive' });

    const wrongPassword = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: 'not-the-password' });
    const unknownEmail = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: PASSWORD });
    const inactive = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'inactive@example.com', password: PASSWORD });

    for (const response of [wrongPassword, unknownEmail, inactive]) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: { code: 'AUTH_INVALID_CREDENTIALS' } });
      expect(setCookies(response)).toEqual([]);
    }
    expect(JSON.stringify(wrongPassword.body)).toBe(JSON.stringify(unknownEmail.body));
    expect(JSON.stringify(wrongPassword.body)).toBe(JSON.stringify(inactive.body));
  });

  it('rejects a body that smuggles a role, rather than silently ignoring it (R3)', async () => {
    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD, role: 'super_admin' });

    expect(response.status).toBe(400);
    expect(setCookies(response)).toEqual([]);
  });

  it('rejects a malformed email and an absent password', async () => {
    await expect(
      harness.http().post('/api/v1/auth/login').send({ email: 'not-an-email', password: PASSWORD }),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      harness.http().post('/api/v1/auth/login').send({ email: EMAIL }),
    ).resolves.toMatchObject({ status: 400 });
  });
});

describe('the guard chain on an ordinary route', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
    await seedAccount(harness);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('TC-7: GET /me with no cookie is 401', async () => {
    const response = await harness.http().get('/api/v1/me');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: { code: 'AUTH_SESSION_INVALID' } });
  });

  it('GET /me with a valid session returns the scope from the token', async () => {
    const jar = jarFrom(await loginOk(harness));
    const response = await harness.http().get('/api/v1/me').set('Cookie', jar);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ role: 'maker', tenantId: 7 });
  });

  it('TC-8: an expired access token is 401, while its session is still perfectly alive', async () => {
    await loginOk(harness);
    const session = harness.sessionStore.sessions[0];

    // The token is *minted* in the past rather than the clock being moved forward. Moving the
    // clock means `jest.useFakeTimers()`, which replaces `Date` and every timer for the whole
    // process — including the ones the live HTTP server and its sockets are using — and that is
    // a genuinely flaky thing to do in a suite that boots real servers. Signing with a past
    // `now` produces exactly the same artefact (a well-formed token whose `exp` has passed)
    // with no global state touched at all.
    const past = new Date(Date.now() - (ACCESS_TOKEN_TTL_SECONDS + 60) * 1000);
    const { token } = harness.tokens.signAccessToken(
      {
        userId: session.userId,
        sessionId: session.id,
        role: 'maker',
        countryId: 1,
        tenantId: 7,
        merchantId: null,
        rbacVersion: 0,
      },
      past,
    );

    const response = await harness
      .http()
      .get('/api/v1/me')
      .set('Cookie', `${ACCESS_COOKIE_NAME}=${token}`);

    expect(response.status).toBe(401);
    // The session itself was never revoked — this is expiry, not revocation.
    expect(harness.sessionStore.sessionFor(session.id).status).toBe('active');
  });

  it('TC-9: a token signed by a different key is 401', async () => {
    const foreign = generateForeignKeyPair();
    const foreignTokens = new TokenService({
      get: (key: string) => (key === 'JWT_PRIVATE_KEY' ? foreign.privateKey : foreign.publicKey),
    } as never);
    const { token } = foreignTokens.signAccessToken(
      {
        userId: 1,
        sessionId: '00000000-0000-4000-8000-000000000000',
        role: 'super_admin',
        countryId: null,
        tenantId: null,
        merchantId: null,
        rbacVersion: 1,
      },
      new Date(),
    );

    const response = await harness
      .http()
      .get('/api/v1/me')
      .set('Cookie', `${ACCESS_COOKIE_NAME}=${token}`);

    expect(response.status).toBe(401);
  });

  it('TC-10: a token forged with alg:none is 401', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: '1', role: 'super_admin' })).toString(
      'base64url',
    );

    const response = await harness
      .http()
      .get('/api/v1/me')
      .set('Cookie', `${ACCESS_COOKIE_NAME}=${header}.${payload}.`);

    expect(response.status).toBe(401);
  });

  it('TC-11: a token forged with HS256 over the public key is 401', async () => {
    const { createHmac } = await import('node:crypto');
    const tokens = harness.tokens;
    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: tokens.kid }),
    ).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: '1', role: 'super_admin' })).toString(
      'base64url',
    );
    const signature = createHmac('sha256', 'whatever-the-attacker-guesses')
      .update(`${header}.${payload}`)
      .digest('base64url');

    const response = await harness
      .http()
      .get('/api/v1/me')
      .set('Cookie', `${ACCESS_COOKIE_NAME}=${header}.${payload}.${signature}`);

    expect(response.status).toBe(401);
  });

  it('TC-17: deactivating the user server-side is 401 on the very next request', async () => {
    const jar = jarFrom(await loginOk(harness));
    await expect(harness.http().get('/api/v1/me').set('Cookie', jar)).resolves.toMatchObject({
      status: 200,
    });

    harness.sessionStore.users[0] = { ...harness.sessionStore.users[0], status: 'inactive' };

    await expect(harness.http().get('/api/v1/me').set('Cookie', jar)).resolves.toMatchObject({
      status: 401,
    });
  });
});

describe('POST /auth/logout (TC-16)', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
    await seedAccount(harness);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('clears all three cookies with attributes matching the setters', async () => {
    const jar = jarFrom(await loginOk(harness));
    const response = await harness.http().post('/api/v1/auth/logout').set('Cookie', jar);

    expect(response.status).toBe(204);
    const cleared = setCookies(response);
    expect(cleared).toHaveLength(3);
    expect(cleared.every((entry) => entry.includes('Max-Age=0'))).toBe(true);
    // T-058: a cookie is only cleared when name, path and domain all match the setter. Clearing
    // on `/api/v1/auth` while setting on `/` would leave a live refresh cookie after logout.
    expect(cleared.find((c) => c.startsWith(REFRESH_COOKIE_NAME))).toContain('Path=/;');
    expect(cleared.every((entry) => entry.includes('Path=/;'))).toBe(true);
  });

  it('makes the access token useless immediately, well inside its 15-minute TTL', async () => {
    const jar = jarFrom(await loginOk(harness));
    await harness.http().post('/api/v1/auth/logout').set('Cookie', jar);

    const after = await harness.http().get('/api/v1/me').set('Cookie', jar);
    expect(after.status).toBe(401);
  });

  it('requires a session of its own', async () => {
    await expect(harness.http().post('/api/v1/auth/logout')).resolves.toMatchObject({
      status: 401,
    });
  });
});

describe('POST /auth/logout-all (TC-18)', () => {
  it("revokes all three of the user's sessions", async () => {
    const harness = await buildHarness();
    await seedAccount(harness);
    const jars = [
      jarFrom(await loginOk(harness)),
      jarFrom(await loginOk(harness)),
      jarFrom(await loginOk(harness)),
    ];

    const response = await harness.http().post('/api/v1/auth/logout-all').set('Cookie', jars[0]);
    expect(response.status).toBe(204);

    for (const jar of jars) {
      await expect(harness.http().get('/api/v1/me').set('Cookie', jar)).resolves.toMatchObject({
        status: 401,
      });
    }
    expect(harness.sessionStore.sessions.every((s) => s.status === 'revoked')).toBe(true);

    await harness.app.close();
  });
});

describe('must_change_password confinement (TC-19, TC-20)', () => {
  let harness: Harness;
  let jar: string;

  beforeEach(async () => {
    harness = await buildHarness();
    await seedAccount(harness, { mustChangePassword: true });
    jar = jarFrom(await loginOk(harness));
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('TC-19: an ordinary route answers 403 PASSWORD_CHANGE_REQUIRED', async () => {
    const response = await harness.http().get('/api/v1/campaigns').set('Cookie', jar);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { code: 'PASSWORD_CHANGE_REQUIRED' } });
  });

  it('the two exempt routes remain reachable', async () => {
    await expect(
      harness.http().get('/api/v1/auth/sessions').set('Cookie', jar),
    ).resolves.toMatchObject({ status: 403 });

    // logout is exempt; change-password is exercised below.
    await expect(
      harness.http().post('/api/v1/auth/logout').set('Cookie', jar),
    ).resolves.toMatchObject({ status: 204 });
  });

  it('TC-20: changing the password clears the flag and unlocks the rest of the API', async () => {
    const change = await harness
      .http()
      .post('/api/v1/auth/change-password')
      .set('Cookie', jar)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(change.status).toBe(204);

    const after = await harness.http().get('/api/v1/campaigns').set('Cookie', jar);
    expect(after.status).toBe(200);
  });

  it('a wrong current password is the same 401 as a failed login', async () => {
    const response = await harness
      .http()
      .post('/api/v1/auth/change-password')
      .set('Cookie', jar)
      .send({ currentPassword: 'wrong', newPassword: NEW_PASSWORD });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: { code: 'AUTH_INVALID_CREDENTIALS' } });
  });

  it('a policy violation is a 400 that says which rule failed', async () => {
    const response = await harness
      .http()
      .post('/api/v1/auth/change-password')
      .set('Cookie', jar)
      .send({ currentPassword: PASSWORD, newPassword: 'Password123!' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('AUTH_PASSWORD_POLICY');
    expect(response.body.error.details.length).toBeGreaterThan(0);
    expect(secretLookingKeys(response.body)).toEqual([]);
  });
});

describe('POST /auth/forgot-password (TC-21)', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
    await seedAccount(harness);
  });

  afterEach(async () => {
    await harness.auth.whenIdle();
    await harness.app.close();
  });

  it('answers 204 for a known and an unknown address alike, with an empty body', async () => {
    const known = await harness.http().post('/api/v1/auth/forgot-password').send({ email: EMAIL });
    const unknown = await harness
      .http()
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nobody@example.com' });

    expect(known.status).toBe(204);
    expect(unknown.status).toBe(204);
    expect(known.text).toBe('');
    expect(unknown.text).toBe('');
  });

  it('TC-21 (structural): the handler returns without awaiting any account-dependent work', async () => {
    // The deterministic half of TC-21, and the one that actually proves the property: a handler
    // that returns `undefined` rather than a promise has, by construction, nothing for Nest to
    // await — so nothing that depends on whether the account exists can have happened yet, and
    // therefore nothing that depends on it can be reflected in the response time.
    //
    // Asserting this through a live HTTP round trip does not work and should not be attempted:
    // by the time supertest observes the response, the detached promise has usually also settled.
    // That is not a failure of the ordering, it is a failure of the vantage point.
    const controller = harness.app.get(AuthController);

    const returned = controller.forgotPassword({ email: EMAIL }, { headers: {} } as never);

    expect(returned).toBeUndefined();
    expect(harness.sessionStore.passwordResets).toHaveLength(0);

    // The work does happen — just after the caller has already been answered.
    await harness.auth.whenIdle();
    expect(harness.sessionStore.passwordResets).toHaveLength(1);
  });

  it('TC-21 (timing): a known address is no slower to answer than an unknown one', async () => {
    // The timing half. It exists to catch someone "tidying up" the detached promise into an
    // `await` — which the structural case above would also catch, but this is the measurement
    // TC-21 actually asks for.
    //
    // The statistic lives in `timing-budget.ts` and is itself tested, deterministically, by
    // `timing-budget.spec.ts`. Read the long comment at the top of that module for why it is
    // shaped the way it is; the short version is that this assertion used to compare two
    // single-draw medians against a fixed 10% bar and consequently failed ~29% of full-suite
    // runs on CPU contention rather than on behaviour (T-086), while passing every time this
    // file was run alone.
    //
    // Three interleaved groups, not two: `knownA` and `knownB` take the *same* code path, so
    // gaps among them measure this machine's jitter and calibrate the bar, while the
    // known-vs-unknown gap is the thing actually under test.
    const measure = async (email: string): Promise<number> => {
      const started = process.hrtime.bigint();
      await harness.http().post('/api/v1/auth/forgot-password').send({ email });
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    // Warm the HTTP stack so one-off JIT costs are not attributed to whichever branch goes first.
    for (let i = 0; i < 5; i += 1) await measure('warmup@example.com');

    const collect = async (): Promise<TimingSamples> => {
      const samples = 30;
      const knownA: number[] = [];
      const knownB: number[] = [];
      const unknown: number[] = [];
      for (let i = 0; i < samples; i += 1) {
        knownA.push(await measure(EMAIL));
        unknown.push(await measure(`nobody${i}@example.com`));
        knownB.push(await measure(EMAIL));
      }
      return { knownA, knownB, unknown };
    };

    const outcome = await measureUntilClean(collect);

    // A leak is reported only when *every* independent trial saw a gap larger than same-path
    // jitter explains — which contention cannot produce, and an awaited Argon2 hash produces
    // every time. The trial summary is in the failure message so a red shows its working.
    expect({ leaked: outcome.leaked, trials: describeTrials(outcome.trials) }).toEqual({
      leaked: false,
      trials: expect.any(String),
    });
  });

  it('rejects a malformed address before doing anything', async () => {
    await expect(
      harness.http().post('/api/v1/auth/forgot-password').send({ email: 'nope' }),
    ).resolves.toMatchObject({ status: 400 });
  });
});

describe('POST /auth/reset-password (TC-22, TC-23)', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
    await seedAccount(harness);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('accepts a fresh token once and refuses the second use', async () => {
    const account = harness.sessionStore.users[0];
    const token = await harness.auth.issuePasswordReset(account.id, new Date());

    await expect(
      harness.http().post('/api/v1/auth/reset-password').send({ token, newPassword: NEW_PASSWORD }),
    ).resolves.toMatchObject({ status: 204 });

    const second = await harness
      .http()
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'Another-Valid-Passphrase!9' });

    expect(second.status).toBe(400);
    expect(second.body).toEqual({ error: { code: 'AUTH_RESET_TOKEN_INVALID' } });
  });

  it('answers the same code for an invented token', async () => {
    const response = await harness
      .http()
      .post('/api/v1/auth/reset-password')
      .send({ token: 'invented-token', newPassword: NEW_PASSWORD });

    expect(response.body).toEqual({ error: { code: 'AUTH_RESET_TOKEN_INVALID' } });
  });
});

describe('POST /auth/refresh over HTTP', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
    await seedAccount(harness);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('issues a whole new cookie set', async () => {
    const login = await loginOk(harness);
    const response = await harness
      .http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', jarFrom(login));

    expect(response.status).toBe(200);
    expect(setCookies(response)).toHaveLength(3);
    expect(cookieValue(response, REFRESH_COOKIE_NAME)).not.toBe(
      cookieValue(login, REFRESH_COOKIE_NAME),
    );
    expect(secretLookingKeys(response.body)).toEqual([]);
  });

  it('answers 401 and clears the cookies when no refresh cookie is presented', async () => {
    const response = await harness.http().post('/api/v1/auth/refresh');

    expect(response.status).toBe(401);
    expect(setCookies(response)).toHaveLength(3);
    expect(setCookies(response).every((entry) => entry.includes('Max-Age=0'))).toBe(true);
  });

  it('TC-13/TC-14: a replayed token is 401 and the surviving access token dies with it', async () => {
    const login = await loginOk(harness);
    const jar = jarFrom(login);
    const rotated = await harness.http().post('/api/v1/auth/refresh').set('Cookie', jar);
    expect(rotated.status).toBe(200);

    const replay = await harness.http().post('/api/v1/auth/refresh').set('Cookie', jar);
    expect(replay.status).toBe(401);
    expect(setCookies(replay).every((entry) => entry.includes('Max-Age=0'))).toBe(true);

    // TC-14: the access token minted by the *successful* rotation is now useless too.
    const afterDetection = await harness.http().get('/api/v1/me').set('Cookie', jarFrom(rotated));
    expect(afterDetection.status).toBe(401);
  });

  it('reports the live must-change flag rather than a stale claim', async () => {
    await seedAccount(harness, { email: 'confined@example.com', mustChangePassword: true });
    const login = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'confined@example.com', password: PASSWORD });

    const refreshed = await harness
      .http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', jarFrom(login));

    expect(refreshed.body.data.mustChangePassword).toBe(true);
  });
});

describe('GET /auth/sessions and DELETE /auth/sessions/:id (TC-24, TC-25)', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
    await seedAccount(harness);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it("TC-24: lists only the caller's own sessions and no token material", async () => {
    const jar = jarFrom(await loginOk(harness));
    await loginOk(harness);

    // A second user with a session of their own, which must not appear.
    const other = harness.sessionStore.seedUser({ email: 'other@example.com' });
    await harness.sessions.start(other, { ipAddress: null, userAgent: null }, new Date());

    const response = await harness.http().get('/api/v1/auth/sessions').set('Cookie', jar);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(secretLookingKeys(response.body)).toEqual([]);
  });

  it("revokes one of the caller's own sessions", async () => {
    const keep = jarFrom(await loginOk(harness));
    const doomed = jarFrom(await loginOk(harness));
    const list = await harness.http().get('/api/v1/auth/sessions').set('Cookie', keep);
    const doomedId = harness.sessionStore.sessions[1].id;
    expect(list.body.data.map((s: { id: string }) => s.id)).toContain(doomedId);

    const response = await harness
      .http()
      .delete(`/api/v1/auth/sessions/${doomedId}`)
      .set('Cookie', keep);

    expect(response.status).toBe(204);
    await expect(harness.http().get('/api/v1/me').set('Cookie', doomed)).resolves.toMatchObject({
      status: 401,
    });
    await expect(harness.http().get('/api/v1/me').set('Cookie', keep)).resolves.toMatchObject({
      status: 200,
    });
  });

  it("TC-25: another user's session id is 404, not 403", async () => {
    const jar = jarFrom(await loginOk(harness));
    const other = harness.sessionStore.seedUser({ email: 'other@example.com' });
    const stranger = await harness.sessions.start(
      other,
      { ipAddress: null, userAgent: null },
      new Date(),
    );

    const response = await harness
      .http()
      .delete(`/api/v1/auth/sessions/${stranger.sessionId}`)
      .set('Cookie', jar);

    // A 403 would confirm the id names a real session (02-SECURITY §5.1).
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { code: 'NOT_FOUND' } });
    expect(harness.sessionStore.sessionFor(stranger.sessionId).status).toBe('active');
  });

  it('a malformed session id is 404 as well, never a 500', async () => {
    const jar = jarFrom(await loginOk(harness));

    const response = await harness
      .http()
      .delete('/api/v1/auth/sessions/not-a-uuid')
      .set('Cookie', jar);

    expect(response.status).toBe(404);
  });
});

describe('requestContext', () => {
  it('tolerates a request with no user-agent and no resolved ip', () => {
    // Both are ordinary for a non-browser client, and both reach code that runs before
    // authentication — neither may throw there.
    expect(requestContext({ headers: {} } as never)).toEqual({ ipAddress: null, userAgent: null });
  });

  it('records what it is given, without ever letting it influence authorisation', () => {
    expect(
      requestContext({ headers: { 'user-agent': 'curl/8' }, ip: '203.0.113.9' } as never),
    ).toEqual({ ipAddress: '203.0.113.9', userAgent: 'curl/8' });
  });
});

describe('TC-26: no auth response contains secret material at any depth', () => {
  it('scans every /auth response this suite can produce', async () => {
    const harness = await buildHarness();
    await seedAccount(harness);

    const login = await loginOk(harness);
    const jar = jarFrom(login);
    const responses = [
      login,
      await harness.http().post('/api/v1/auth/login').send({ email: EMAIL, password: 'wrong' }),
      await harness.http().post('/api/v1/auth/refresh').set('Cookie', jar),
      await harness.http().get('/api/v1/auth/sessions').set('Cookie', jar),
      await harness.http().post('/api/v1/auth/forgot-password').send({ email: EMAIL }),
      await harness
        .http()
        .post('/api/v1/auth/reset-password')
        .send({ token: 'nope', newPassword: NEW_PASSWORD }),
    ];

    for (const response of responses) {
      expect(secretLookingKeys(response.body)).toEqual([]);
    }

    await harness.auth.whenIdle();
    await harness.app.close();
  });
});
