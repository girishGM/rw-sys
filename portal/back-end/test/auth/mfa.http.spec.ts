/**
 * T-055 — `/auth/mfa/*` and the administrative reset over real HTTP, with in-memory stores behind
 * them, in the shape `auth.http.spec.ts` established for T-011.
 *
 * This is where the **transport** is pinned: the exact cookies set and cleared, the exact status
 * codes and bodies, the login response that starts the whole flow, and TC-18's recursive scan for
 * secret material in a response body. `mfa.e2e-spec.ts` runs the same endpoints against real
 * Postgres; neither file replaces the other.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as argon2 from 'argon2';

jest.mock('@/database/database.module', () => jest.requireActual('./support/fake-database.module'));
jest.mock('@/config/config.module', () => jest.requireActual('./support/fake-config.module'));

import { randomBytes } from 'node:crypto';
import { FieldCryptoService } from '@/common/crypto/field-crypto.service';
import { KeyRegistryService, type RegisteredKey } from '@/common/crypto/key-registry.service';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { AuthModule } from '@/modules/auth/auth.module';
import { MFA_PENDING_COOKIE_NAME, MFA_ERROR_CODE } from '@/modules/auth/mfa.constants';
import {
  ACCESS_COOKIE_NAME,
  AUTH_ERROR_CODE,
  CSRF_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
} from '@/modules/auth/session.constants';
import { CREDENTIAL_STORE } from '@/modules/auth/services/credential.repository';
import { MFA_STORE } from '@/modules/auth/services/mfa.repository';
import { SESSION_STORE } from '@/modules/auth/services/session.repository';
import { MfaPendingTokenService } from '@/modules/auth/services/mfa-pending-token.service';
import { decodeBase32, totpCodeAt } from '@/modules/auth/services/totp';
import { TokenService } from '@/modules/auth/services/token.service';
import { bindTestServer } from '../security/support/bound-app';
import { FakeCredentialStore } from './support/fake-credential-store';
import { FakeMfaStore } from './support/fake-mfa-store';
import { FakeSessionStore } from './support/fake-session-store';

jest.setTimeout(120_000);

const PASSWORD = 'correct horse battery staple 7!';
const EMAIL = 'super-admin@example.invalid';
const OTHER_EMAIL = 'second-super-admin@example.invalid';

type HttpAgent = ReturnType<typeof request>;

interface Harness {
  app: INestApplication;
  http: () => HttpAgent;
  credentialStore: FakeCredentialStore;
  sessionStore: FakeSessionStore;
  mfaStore: FakeMfaStore;
  pendingTokens: MfaPendingTokenService;
  crypto: FieldCryptoService;
  tokens: TokenService;
}

/** One AES-256-GCM key, generated per process and never written down (R4). */
function stubKeyRegistry(): KeyRegistryService {
  const key: RegisteredKey = {
    kid: 'k-http-mfa',
    purpose: 'field',
    algorithm: 'AES-256-GCM',
    status: 'active',
    material: randomBytes(32),
  };
  return {
    getActiveKey: () => key,
    getKeyForDecryption: () => key,
    onModuleInit: async () => undefined,
    onModuleDestroy: () => undefined,
  } as unknown as KeyRegistryService;
}

async function buildHarness(): Promise<Harness> {
  const credentialStore = new FakeCredentialStore();
  const sessionStore = new FakeSessionStore();
  const mfaStore = new FakeMfaStore();

  const moduleRef = await Test.createTestingModule({ imports: [AuthModule] })
    .overrideProvider(CREDENTIAL_STORE)
    .useValue(credentialStore)
    .overrideProvider(SESSION_STORE)
    .useValue(sessionStore)
    .overrideProvider(MFA_STORE)
    .useValue(mfaStore)
    .overrideProvider(KeyRegistryService)
    .useValue(stubKeyRegistry())
    .compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();
  // T-087: bind once, then aim supertest at the base URL — see `auth.http.spec.ts`'s note and
  // `bound-app.ts` for why `request(app.getHttpServer())` on a non-listening server misroutes.
  const base = await bindTestServer(app);

  return {
    app,
    http: () => request(base),
    credentialStore,
    sessionStore,
    mfaStore,
    pendingTokens: app.get(MfaPendingTokenService),
    crypto: app.get(FieldCryptoService),
    tokens: app.get(TokenService),
  };
}

/** Seeds one `super_admin` into all three fake stores, ids aligned. */
async function seedSuperAdmin(
  harness: Harness,
  email: string,
  overrides: Record<string, unknown> = {},
): Promise<number> {
  const user = harness.mfaStore.seedUser({ email, role: 'super_admin', ...overrides });
  harness.sessionStore.seedUser({
    id: user.id,
    email,
    role: 'super_admin',
    countryId: null,
    tenantId: null,
    merchantId: null,
    mustChangePassword: false,
    mfaEnabled: user.mfaEnabled,
  });
  harness.credentialStore.seedUser({
    id: user.id,
    email,
    role: 'super_admin',
    countryId: null,
    tenantId: null,
    merchantId: null,
    mustChangePassword: false,
    mfaEnabled: user.mfaEnabled,
  });
  harness.credentialStore.seedCredential(user.id, await argon2.hash(PASSWORD, ARGON2_OPTIONS));
  return user.id;
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

/** The seed as an authenticator app would hold it, read straight out of the store. */
function secretFor(harness: Harness, userId: number): Buffer {
  const enc = harness.mfaStore.userFor(userId).secretEnc;
  if (enc === null) throw new Error('no secret stored');
  return decodeBase32(
    harness.crypto.decrypt(enc, {
      aad: FieldCryptoService.aadFor('reward_portal.portal_users', userId),
    }),
  );
}

/** Walks a response body and fails on any key that could carry secret material (TC-18). */
function assertNoSecretMaterial(
  value: unknown,
  path = 'body',
  allow: readonly string[] = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretMaterial(entry, `${path}[${index}]`, allow));
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  for (const [key, child] of Object.entries(value)) {
    if (!allow.includes(key) && /hash|secret|token|password/i.test(key)) {
      throw new Error(`response leaked ${path}.${key}`);
    }
    assertNoSecretMaterial(child, `${path}.${key}`, allow);
  }
}

describe('POST /auth/login — the step-up branch (TC-3, TC-15)', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('TC-3: an unenrolled super_admin gets mfaRequired, a pending cookie and NO session', async () => {
    await seedSuperAdmin(harness, EMAIL);

    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: { role: 'super_admin', mustChangePassword: false, mfaRequired: true },
    });

    // None of the three session cookies, and no `portal_sessions` row (TC-14).
    expect(cookieNamed(response, ACCESS_COOKIE_NAME)).toBeUndefined();
    expect(cookieNamed(response, REFRESH_COOKIE_NAME)).toBeUndefined();
    expect(cookieNamed(response, CSRF_COOKIE_NAME)).toBeUndefined();
    expect(harness.sessionStore.sessions).toHaveLength(0);
    expect(harness.sessionStore.refreshTokens).toHaveLength(0);

    const pending = cookieNamed(response, MFA_PENDING_COOKIE_NAME) as string;
    expect(pending).toContain('HttpOnly');
    expect(pending).toContain('Secure');
    expect(pending).toContain('SameSite=Strict');
    expect(pending).toContain('Path=/');
    expect(pending).toContain('Max-Age=300');
  });

  it('the login body carries no token of any kind, pending or otherwise (T-011 TC-26)', async () => {
    await seedSuperAdmin(harness, EMAIL);

    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD });

    assertNoSecretMaterial(response.body, 'body', ['mustChangePassword']);
    expect(JSON.stringify(response.body)).not.toContain('mfa1.');
  });

  it('TC-15: a non-super_admin logs in exactly as before T-055', async () => {
    const user = harness.sessionStore.seedUser({
      role: 'country_admin',
      countryId: 1,
      tenantId: null,
    });
    harness.credentialStore.seedUser({
      id: user.id,
      email: user.email,
      role: 'country_admin',
      countryId: 1,
      tenantId: null,
      merchantId: null,
      mustChangePassword: false,
    });
    harness.credentialStore.seedCredential(user.id, await argon2.hash(PASSWORD, ARGON2_OPTIONS));

    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.data.mfaRequired).toBe(false);
    expect(cookieNamed(response, ACCESS_COOKIE_NAME)).toBeDefined();
    expect(cookieNamed(response, MFA_PENDING_COOKIE_NAME)).toBeUndefined();
    expect(harness.sessionStore.sessions).toHaveLength(1);
  });
});

describe('/auth/mfa/*', () => {
  let harness: Harness;
  let userId: number;

  beforeEach(async () => {
    harness = await buildHarness();
    userId = await seedSuperAdmin(harness, EMAIL);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  /** Logs in and returns the pending cookie value, as a browser would hold it. */
  async function loginForChallenge(): Promise<string> {
    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD });
    return cookieValue(response, MFA_PENDING_COOKIE_NAME);
  }

  it('TC-5/TC-1: enrol then verify, using only the cookie the login set', async () => {
    const pending = await loginForChallenge();

    const enrolment = await harness
      .http()
      .post('/api/v1/auth/mfa/enrol')
      .set('Cookie', `${MFA_PENDING_COOKIE_NAME}=${encodeURIComponent(pending)}`)
      .send({});

    expect(enrolment.status).toBe(200);
    expect(enrolment.body.data.otpauthUri).toContain('otpauth://totp/');
    expect(enrolment.body.data.account).toBe(EMAIL);

    const verify = await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .set('Cookie', `${MFA_PENDING_COOKIE_NAME}=${encodeURIComponent(pending)}`)
      .send({ totpCode: totpCodeAt(secretFor(harness, userId), new Date()) });

    expect(verify.status).toBe(200);
    expect(verify.body.data.role).toBe('super_admin');
    expect(verify.body.data.mfaRequired).toBe(false);
    expect(verify.body.data.recoveryCodes).toHaveLength(10);

    // TC-6: all three session cookies, and the pending cookie cleared.
    expect(cookieNamed(verify, ACCESS_COOKIE_NAME)).toBeDefined();
    expect(cookieNamed(verify, REFRESH_COOKIE_NAME)).toBeDefined();
    expect(cookieNamed(verify, CSRF_COOKIE_NAME)).toBeDefined();
    expect(cookieNamed(verify, MFA_PENDING_COOKIE_NAME)).toContain('Max-Age=0');
    expect(harness.mfaStore.userFor(userId).mfaEnabled).toBe(true);
  });

  it('accepts the token in the body, the shape 02-SECURITY.md §2a writes', async () => {
    const pending = await loginForChallenge();

    const enrolment = await harness
      .http()
      .post('/api/v1/auth/mfa/enrol')
      .send({ mfaPendingToken: pending });

    expect(enrolment.status).toBe(200);

    const verify = await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({
        mfaPendingToken: pending,
        totpCode: totpCodeAt(secretFor(harness, userId), new Date()),
      });

    expect(verify.status).toBe(200);
  });

  it('TC-7: a wrong code answers a generic 401 and sets no cookie', async () => {
    const pending = await loginForChallenge();
    await harness.http().post('/api/v1/auth/mfa/enrol').send({ mfaPendingToken: pending });
    await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({
        mfaPendingToken: pending,
        totpCode: totpCodeAt(secretFor(harness, userId), new Date()),
      });

    const wrong = await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaPendingToken: pending, totpCode: '000000' });

    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe(AUTH_ERROR_CODE.INVALID_CREDENTIALS);
    expect(cookieNamed(wrong, ACCESS_COOKIE_NAME)).toBeUndefined();
  });

  it('TC-13: an expired or absent pending token answers 401 AUTH_SESSION_INVALID', async () => {
    const expired = harness.pendingTokens.mint(
      { userId, enrolled: false },
      new Date(Date.now() - 10 * 60 * 1000),
    );

    const withExpired = await harness
      .http()
      .post('/api/v1/auth/mfa/enrol')
      .send({ mfaPendingToken: expired });
    expect(withExpired.status).toBe(401);
    expect(withExpired.body.error.code).toBe(AUTH_ERROR_CODE.SESSION_INVALID);

    const without = await harness.http().post('/api/v1/auth/mfa/enrol').send({});
    expect(without.status).toBe(401);
    expect(without.body.error.code).toBe(AUTH_ERROR_CODE.SESSION_INVALID);
  });

  it('TC-2: a second enrolment attempt is refused with MFA_ALREADY_ENROLLED', async () => {
    const pending = await loginForChallenge();
    await harness.http().post('/api/v1/auth/mfa/enrol').send({ mfaPendingToken: pending });
    await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({
        mfaPendingToken: pending,
        totpCode: totpCodeAt(secretFor(harness, userId), new Date()),
      });

    const again = await harness
      .http()
      .post('/api/v1/auth/mfa/enrol')
      .send({ mfaPendingToken: pending });

    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe(MFA_ERROR_CODE.ALREADY_ENROLLED);
    expect(again.body.data).toBeUndefined();
  });

  it('TC-11: recovery logs in, reports the remaining count and clears the pending cookie', async () => {
    const pending = await loginForChallenge();
    await harness.http().post('/api/v1/auth/mfa/enrol').send({ mfaPendingToken: pending });
    const enrolled = await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({
        mfaPendingToken: pending,
        totpCode: totpCodeAt(secretFor(harness, userId), new Date()),
      });
    const codes: string[] = enrolled.body.data.recoveryCodes;

    const recovered = await harness
      .http()
      .post('/api/v1/auth/mfa/recover')
      .send({ mfaPendingToken: pending, recoveryCode: codes[0] });

    expect(recovered.status).toBe(200);
    expect(recovered.body.data.recoveryCodesRemaining).toBe(9);
    expect(recovered.body.data.recoveryCodes).toBeUndefined();
    expect(cookieNamed(recovered, ACCESS_COOKIE_NAME)).toBeDefined();

    // TC-12: the same code again is rejected.
    const reuse = await harness
      .http()
      .post('/api/v1/auth/mfa/recover')
      .send({ mfaPendingToken: pending, recoveryCode: codes[0] });
    expect(reuse.status).toBe(401);
  });

  it('TC-18: no MFA response body carries anything secret beyond the two one-shot fields', async () => {
    const pending = await loginForChallenge();

    const enrolment = await harness
      .http()
      .post('/api/v1/auth/mfa/enrol')
      .send({ mfaPendingToken: pending });
    // `secret` is the one-shot enrolment payload TC-1 requires; nothing else may match.
    assertNoSecretMaterial(enrolment.body, 'body', ['secret']);

    const verify = await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({
        mfaPendingToken: pending,
        totpCode: totpCodeAt(secretFor(harness, userId), new Date()),
      });
    assertNoSecretMaterial(verify.body, 'body', ['mustChangePassword', 'recoveryCodes']);
    // The ciphertext never appears, and neither does the pending token.
    expect(JSON.stringify(verify.body)).not.toContain('v1.k-http-mfa');
    expect(JSON.stringify(verify.body)).not.toContain(pending);
  });

  it('a completed login drops a challenge left over in the same browser', async () => {
    // The scenario: a `super_admin` starts a challenge, abandons it, and somebody signs in as a
    // different user in the same browser within the five minutes. Without the clear, the stale
    // pending cookie would confine that new, perfectly valid session (`MfaPendingConfinementGuard`).
    const pending = await loginForChallenge();

    const maker = harness.sessionStore.seedUser({ role: 'maker', countryId: 1, tenantId: 7 });
    harness.credentialStore.seedUser({
      id: maker.id,
      email: maker.email,
      role: 'maker',
      countryId: 1,
      tenantId: 7,
      merchantId: null,
      mustChangePassword: false,
    });
    harness.credentialStore.seedCredential(maker.id, await argon2.hash(PASSWORD, ARGON2_OPTIONS));

    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .set('Cookie', `${MFA_PENDING_COOKIE_NAME}=${encodeURIComponent(pending)}`)
      .send({ email: maker.email, password: PASSWORD });

    expect(response.status).toBe(200);
    expect(cookieNamed(response, ACCESS_COOKIE_NAME)).toBeDefined();
    expect(cookieNamed(response, MFA_PENDING_COOKIE_NAME)).toContain('Max-Age=0');
  });

  it('a logout drops a challenge the browser is still carrying', async () => {
    const pending = await loginForChallenge();
    await harness.http().post('/api/v1/auth/mfa/enrol').send({ mfaPendingToken: pending });
    const verified = await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({
        mfaPendingToken: pending,
        totpCode: totpCodeAt(secretFor(harness, userId), new Date()),
      });

    const jar = setCookies(verified)
      .map((entry) => entry.split(';')[0])
      .filter((pair) => !pair.endsWith('='))
      .join('; ');

    const response = await harness
      .http()
      .post('/api/v1/auth/logout')
      .set('Cookie', `${jar}; ${MFA_PENDING_COOKIE_NAME}=${encodeURIComponent(pending)}`)
      .set('x-csrf-token', cookieValue(verified, CSRF_COOKIE_NAME))
      .send();

    expect(response.status).toBe(204);
    expect(cookieNamed(response, MFA_PENDING_COOKIE_NAME)).toContain('Max-Age=0');
  });

  it('rejects a body carrying an unexpected field, before any of this runs', async () => {
    // `forbidNonWhitelisted` — a client cannot smuggle `userId` into an MFA call (R3).
    const response = await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaPendingToken: 'x', totpCode: '123456', userId: 1 });

    expect(response.status).toBe(400);
  });

  const malformedVerifyBodies: [string, Record<string, unknown>][] = [
    ['no code at all', {}],
    ['a five-digit code', { totpCode: '12345' }],
    ['an over-long code', { totpCode: '123456789' }],
  ];

  it.each(malformedVerifyBodies)('rejects %s at the validation layer', async (_label, body) => {
    const response = await harness.http().post('/api/v1/auth/mfa/verify').send(body);
    expect(response.status).toBe(400);
  });

  it('rejects a recovery code of the wrong length at the validation layer', async () => {
    const response = await harness
      .http()
      .post('/api/v1/auth/mfa/recover')
      .send({ recoveryCode: 'SHORT' });
    expect(response.status).toBe(400);
  });
});

describe('POST /admin/access-control/super-admins/:id/mfa-reset', () => {
  let harness: Harness;
  let actorId: number;
  let targetId: number;

  beforeEach(async () => {
    harness = await buildHarness();
    actorId = await seedSuperAdmin(harness, EMAIL, { mfaEnabled: true });
    targetId = await seedSuperAdmin(harness, OTHER_EMAIL, { mfaEnabled: true });
  });

  afterEach(async () => {
    await harness.app.close();
  });

  /** A session cookie jar for a user, minted directly — the login path is tested above. */
  async function jarFor(userId: number): Promise<{ cookie: string; csrf: string }> {
    const session = await harness.sessionStore.createSession({
      userId,
      ipAddress: null,
      userAgent: null,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const { token } = harness.tokens.signAccessToken(
      {
        userId,
        sessionId: session.id,
        role: 'super_admin',
        countryId: null,
        tenantId: null,
        merchantId: null,
        rbacVersion: 1,
      },
      new Date(),
    );
    return {
      cookie: `${ACCESS_COOKIE_NAME}=${encodeURIComponent(token)}`,
      csrf: harness.tokens.csrfTokenFor(session.id),
    };
  }

  it('TC-17: resets the target and answers 204', async () => {
    const jar = await jarFor(actorId);

    const response = await harness
      .http()
      .post(`/api/v1/admin/access-control/super-admins/${targetId}/mfa-reset`)
      .set('Cookie', jar.cookie)
      .set('x-csrf-token', jar.csrf)
      .send({});

    expect(response.status).toBe(204);
    expect(response.body).toEqual({});
    expect(harness.mfaStore.userFor(targetId).mfaEnabled).toBe(false);
  });

  it('answers 404 for a malformed id without touching the database', async () => {
    const jar = await jarFor(actorId);

    const response = await harness
      .http()
      .post('/api/v1/admin/access-control/super-admins/not-a-number/mfa-reset')
      .set('Cookie', jar.cookie)
      .set('x-csrf-token', jar.csrf)
      .send({});

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe(AUTH_ERROR_CODE.NOT_FOUND);
  });

  it('is unreachable without a session at all', async () => {
    const response = await harness
      .http()
      .post(`/api/v1/admin/access-control/super-admins/${targetId}/mfa-reset`)
      .send({});

    expect(response.status).toBe(401);
  });

  it('TC-16: refuses an actor whose own MFA is not satisfied', async () => {
    const unenrolledId = await seedSuperAdmin(harness, 'third@example.invalid', {
      mfaEnabled: false,
    });
    const jar = await jarFor(unenrolledId);

    const response = await harness
      .http()
      .post(`/api/v1/admin/access-control/super-admins/${targetId}/mfa-reset`)
      .set('Cookie', jar.cookie)
      .set('x-csrf-token', jar.csrf)
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe(MFA_ERROR_CODE.ENROLMENT_REQUIRED);
    expect(harness.mfaStore.userFor(targetId).mfaEnabled).toBe(true);
  });
});
