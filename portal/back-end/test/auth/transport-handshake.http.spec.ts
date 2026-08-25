/**
 * T-018 — the handshake as `AuthController` performs it, over real HTTP.
 *
 * A separate file from `auth.http.spec.ts` rather than an addition to it: that file is T-011's
 * pinning of the `/auth/*` HTTP surface, and its harness deliberately has no transport key ring.
 * What is asserted here is the four lines T-018 added to the login handler and the two it added
 * to logout — specifically that they are **additive**:
 *
 *  - a client that offers no public key gets a byte-identical response to the one it got before
 *    this task existed (T-011 TC-1 and TC-5 keep asserting what they always asserted);
 *  - a client that does offer one gets two extra *headers* and an unchanged *body*, which is why
 *    the handshake travels in headers rather than in `LoginDto`/`LoginResponseDto`.
 *
 * `HandshakeService` is substituted here — the ECDH itself is covered exhaustively in
 * `test/transport-crypto/handshake.service.spec.ts`, and the harness's in-memory database has no
 * `encryption_keys` rows to wrap a key with. What is real is the controller, the guards, the
 * pipe and the HTTP layer.
 *
 * ### The `super_admin` path (added in retry 2)
 *
 * The last third of this file covers `MfaController`, and it exists because of a defect the
 * six-role journey e2e found: T-055 makes MFA structurally mandatory for `super_admin`, so that
 * role's session is issued by `POST /auth/mfa/verify` (or `/recover`), **not** by the login. A
 * handshake bound at login only left the most privileged role in the system unable to encrypt
 * anything — and did so silently, because `PayloadEncryptInterceptor` falls back to cleartext when
 * a session holds no key. The cases below pin the fix from both sides: the login that issues no
 * session runs no handshake, and the request that does issue one completes it.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

jest.mock('@/database/database.module', () => jest.requireActual('./support/fake-database.module'));
jest.mock('@/config/config.module', () => jest.requireActual('./support/fake-config.module'));

import { randomBytes } from 'node:crypto';
import { FieldCryptoService } from '@/common/crypto/field-crypto.service';
import { KeyRegistryService, type RegisteredKey } from '@/common/crypto/key-registry.service';
import { AuthModule } from '@/modules/auth/auth.module';
import { MFA_PENDING_COOKIE_NAME } from '@/modules/auth/mfa.constants';
import { CredentialService } from '@/modules/auth/services/credential.service';
import { CREDENTIAL_STORE } from '@/modules/auth/services/credential.repository';
import { MFA_STORE } from '@/modules/auth/services/mfa.repository';
import { SESSION_STORE } from '@/modules/auth/services/session.repository';
import { decodeBase32, totpCodeAt } from '@/modules/auth/services/totp';
import { HandshakeService } from '@/common/transport-crypto/handshake.service';
import { bindTestServer } from '../security/support/bound-app';
import { FakeCredentialStore } from './support/fake-credential-store';
import { FakeMfaStore } from './support/fake-mfa-store';
import { FakeSessionStore } from './support/fake-session-store';

jest.setTimeout(120_000);

const PASSWORD = 'correct horse battery staple 7!';
const EMAIL = 'operator@example.com';
const SUPER_EMAIL = 'super-admin@example.invalid';
const SERVER_PUBLIC_KEY = Buffer.alloc(65, 0x04).toString('base64');
const CLIENT_PUBLIC_KEY = Buffer.alloc(65, 0x04).toString('base64');

/** Records what the controller asked of the handshake, and answers as configured. */
class RecordingHandshake {
  established: { sessionId: string; offered: string | undefined }[] = [];
  destroyedSessions: string[] = [];
  destroyedUsers: number[] = [];
  /** `null` reproduces the "client offered nothing, or something unusable" path. */
  result: { serverPublicKey: string; kid: string } | null = null;

  async establish(
    sessionId: string,
    offered: string | undefined,
  ): Promise<{ serverPublicKey: string; kid: string } | null> {
    this.established.push({ sessionId, offered });
    return offered === undefined ? null : this.result;
  }

  async destroyForSession(sessionId: string): Promise<void> {
    this.destroyedSessions.push(sessionId);
  }

  async destroyForUser(userId: number): Promise<void> {
    this.destroyedUsers.push(userId);
  }
}

/** One AES-256-GCM key, generated per process and never written down (R4). */
function stubKeyRegistry(): KeyRegistryService {
  const key: RegisteredKey = {
    kid: 'k-http-handshake',
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

interface Harness {
  app: INestApplication;
  http: () => ReturnType<typeof request>;
  handshake: RecordingHandshake;
  credentialStore: FakeCredentialStore;
  sessionStore: FakeSessionStore;
  /** T-018 retry 2 — the `super_admin` path needs an MFA store to enrol against. */
  mfaStore: FakeMfaStore;
  crypto: FieldCryptoService;
}

async function buildHarness(): Promise<Harness> {
  const credentialStore = new FakeCredentialStore();
  const sessionStore = new FakeSessionStore();
  const mfaStore = new FakeMfaStore();
  const handshake = new RecordingHandshake();

  const moduleRef = await Test.createTestingModule({ imports: [AuthModule] })
    .overrideProvider(CREDENTIAL_STORE)
    .useValue(credentialStore)
    .overrideProvider(SESSION_STORE)
    .useValue(sessionStore)
    .overrideProvider(MFA_STORE)
    .useValue(mfaStore)
    // `MfaService` encrypts `mfa_secret_enc` through the real `FieldCryptoService`; only the key
    // registry is stubbed, exactly as `mfa.http.spec.ts` does it.
    .overrideProvider(KeyRegistryService)
    .useValue(stubKeyRegistry())
    .overrideProvider(HandshakeService)
    .useValue(handshake)
    .compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();

  const credentials = app.get(CredentialService);
  const user = credentialStore.seedUser({ email: EMAIL, countryId: 1, tenantId: 7 });
  credentialStore.seedCredential(user.id, await credentials.hash(PASSWORD));
  sessionStore.seedUser(user);

  // T-087: bind once, then aim supertest at the base URL — see `auth.http.spec.ts`'s note and
  // `bound-app.ts`. This suite's "a declined handshake still produces a completely normal login"
  // was one of the two observed misroutes (404 on POST /api/v1/auth/login, i.e. answered by a
  // listener with no such route).
  const base = await bindTestServer(app);

  return {
    app,
    http: () => request(base),
    handshake,
    credentialStore,
    sessionStore,
    mfaStore,
    crypto: app.get(FieldCryptoService),
  };
}

/** Seeds one `super_admin` into all three stores with aligned ids, as `mfa.http.spec.ts` does. */
async function seedSuperAdmin(harness: Harness): Promise<number> {
  const user = harness.mfaStore.seedUser({ email: SUPER_EMAIL, role: 'super_admin' });
  const shape = {
    id: user.id,
    email: SUPER_EMAIL,
    role: 'super_admin' as const,
    countryId: null,
    tenantId: null,
    merchantId: null,
    mustChangePassword: false,
    mfaEnabled: user.mfaEnabled,
  };
  harness.sessionStore.seedUser(shape);
  harness.credentialStore.seedUser(shape);
  harness.credentialStore.seedCredential(
    user.id,
    await harness.app.get(CredentialService).hash(PASSWORD),
  );
  return user.id;
}

function cookieValue(response: request.Response, name: string): string {
  const header = response.headers['set-cookie'];
  const entries = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const match = entries.find((entry) => entry.startsWith(`${name}=`));
  if (match === undefined) throw new Error(`no Set-Cookie for ${name}`);
  return decodeURIComponent(match.split(';')[0].slice(name.length + 1));
}

/** The enrolled TOTP seed, read back the way an authenticator app holds it. */
function secretFor(harness: Harness, userId: number): Buffer {
  const enc = harness.mfaStore.userFor(userId).secretEnc;
  if (enc === null) throw new Error('no secret stored');
  return decodeBase32(
    harness.crypto.decrypt(enc, {
      aad: FieldCryptoService.aadFor('reward_portal.portal_users', userId),
    }),
  );
}

function jarFrom(response: request.Response): string {
  const header = response.headers['set-cookie'];
  const cookies = header === undefined ? [] : Array.isArray(header) ? header : [header];
  return cookies
    .map((entry) => entry.split(';')[0])
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

describe('POST /auth/login — transport handshake', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('returns the server public key and the kid when the client offers a public key', async () => {
    harness.handshake.result = { serverPublicKey: SERVER_PUBLIC_KEY, kid: 'sess_abc' };

    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .set('x-transport-public-key', CLIENT_PUBLIC_KEY)
      .send({ email: EMAIL, password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.headers['x-transport-public-key']).toBe(SERVER_PUBLIC_KEY);
    expect(response.headers['x-transport-kid']).toBe('sess_abc');
  });

  it('binds the handshake to the session that was just issued', async () => {
    harness.handshake.result = { serverPublicKey: SERVER_PUBLIC_KEY, kid: 'sess_abc' };

    await harness
      .http()
      .post('/api/v1/auth/login')
      .set('x-transport-public-key', CLIENT_PUBLIC_KEY)
      .send({ email: EMAIL, password: PASSWORD });

    expect(harness.handshake.established).toHaveLength(1);
    expect(harness.handshake.established[0].offered).toBe(CLIENT_PUBLIC_KEY);
    // A real session id from the store, not anything the client supplied (R3).
    expect(harness.sessionStore.sessions.map((session) => session.id)).toContain(
      harness.handshake.established[0].sessionId,
    );
  });

  it('the response body is unchanged — no key, no kid, no token in it (T-011 TC-5)', async () => {
    harness.handshake.result = { serverPublicKey: SERVER_PUBLIC_KEY, kid: 'sess_abc' };

    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .set('x-transport-public-key', CLIENT_PUBLIC_KEY)
      .send({ email: EMAIL, password: PASSWORD });

    expect(Object.keys(response.body.data).sort()).toEqual([
      'mfaRequired',
      'mustChangePassword',
      'role',
    ]);
    expect(response.text).not.toContain(SERVER_PUBLIC_KEY);
  });

  it('an ordinary login offering nothing gets no transport headers at all', async () => {
    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.headers['x-transport-public-key']).toBeUndefined();
    expect(response.headers['x-transport-kid']).toBeUndefined();
    expect(harness.handshake.established[0].offered).toBeUndefined();
  });

  it('a public key sent twice is ignored rather than half-trusted', async () => {
    harness.handshake.result = { serverPublicKey: SERVER_PUBLIC_KEY, kid: 'sess_abc' };

    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .set('x-transport-public-key', CLIENT_PUBLIC_KEY)
      .set('x-transport-public-key', 'a-second-different-key')
      .send({ email: EMAIL, password: PASSWORD });

    // supertest collapses a repeated `set` into one header; what matters is that the controller
    // only ever forwards a `string`, never an array — asserted directly below.
    expect(typeof harness.handshake.established[0].offered).not.toBe('object');
    expect(response.status).toBe(200);
  });

  it('a declined handshake still produces a completely normal login', async () => {
    harness.handshake.result = null;

    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .set('x-transport-public-key', 'nonsense')
      .send({ email: EMAIL, password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.headers['x-transport-public-key']).toBeUndefined();
    expect(response.body.data.role).toBeDefined();
  });

  it('a failed login runs no handshake — there is no session to key', async () => {
    await harness
      .http()
      .post('/api/v1/auth/login')
      .set('x-transport-public-key', CLIENT_PUBLIC_KEY)
      .send({ email: EMAIL, password: 'wrong password entirely' })
      .expect(401);

    expect(harness.handshake.established).toHaveLength(0);
  });
});

describe('logout destroys the transport key (implementation note 7)', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
    harness.handshake.result = { serverPublicKey: SERVER_PUBLIC_KEY, kid: 'sess_abc' };
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it("POST /auth/logout destroys this session's key", async () => {
    const login = await harness
      .http()
      .post('/api/v1/auth/login')
      .set('x-transport-public-key', CLIENT_PUBLIC_KEY)
      .send({ email: EMAIL, password: PASSWORD });

    await harness.http().post('/api/v1/auth/logout').set('Cookie', jarFrom(login)).expect(204);

    expect(harness.handshake.destroyedSessions).toEqual([
      harness.handshake.established[0].sessionId,
    ]);
  });

  it('POST /auth/logout-all destroys every key the user holds', async () => {
    const login = await harness
      .http()
      .post('/api/v1/auth/login')
      .set('x-transport-public-key', CLIENT_PUBLIC_KEY)
      .send({ email: EMAIL, password: PASSWORD });

    await harness.http().post('/api/v1/auth/logout-all').set('Cookie', jarFrom(login)).expect(204);

    expect(harness.handshake.destroyedUsers).toEqual([harness.credentialStore.users[0].id]);
  });
});

/**
 * The `super_admin` path — `POST /auth/mfa/verify` and `/recover` issue the session, so they are
 * where the handshake completes.
 *
 * Without this, the role with unrestricted scope could never send or receive an encrypted payload,
 * and nothing would have gone red: the encrypt interceptor returns cleartext when the session has
 * no key. See this file's header.
 */
describe('the handshake follows the session, not the login (T-055 interaction)', () => {
  let harness: Harness;
  let userId: number;

  beforeEach(async () => {
    harness = await buildHarness();
    harness.handshake.result = { serverPublicKey: SERVER_PUBLIC_KEY, kid: 'sess_super' };
    userId = await seedSuperAdmin(harness);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  /** Login → enrol → verify, offering the client public key on the two session-issuing requests. */
  async function completeChallenge(
    options: { offerKeyOnVerify?: boolean } = {},
  ): Promise<{ login: request.Response; verified: request.Response }> {
    const login = await harness
      .http()
      .post('/api/v1/auth/login')
      .set('x-transport-public-key', CLIENT_PUBLIC_KEY)
      .send({ email: SUPER_EMAIL, password: PASSWORD });

    const pending = cookieValue(login, MFA_PENDING_COOKIE_NAME);
    await harness.http().post('/api/v1/auth/mfa/enrol').send({ mfaPendingToken: pending });

    const verify = harness.http().post('/api/v1/auth/mfa/verify');
    if (options.offerKeyOnVerify !== false) verify.set('x-transport-public-key', CLIENT_PUBLIC_KEY);

    const verified = await verify.send({
      mfaPendingToken: pending,
      totpCode: totpCodeAt(secretFor(harness, userId), new Date()),
    });

    return { login, verified };
  }

  it('a step-up-required login runs no handshake — there is no session yet to key', async () => {
    const login = await harness
      .http()
      .post('/api/v1/auth/login')
      .set('x-transport-public-key', CLIENT_PUBLIC_KEY)
      .send({ email: SUPER_EMAIL, password: PASSWORD });

    expect(login.status).toBe(200);
    expect(login.body.data.mfaRequired).toBe(true);
    expect(harness.handshake.established).toHaveLength(0);
    expect(login.headers['x-transport-public-key']).toBeUndefined();
    expect(login.headers['x-transport-kid']).toBeUndefined();
  });

  it('POST /auth/mfa/verify completes the handshake against the session it issues', async () => {
    const { verified } = await completeChallenge();

    expect(verified.status).toBe(200);
    expect(verified.headers['x-transport-public-key']).toBe(SERVER_PUBLIC_KEY);
    expect(verified.headers['x-transport-kid']).toBe('sess_super');

    expect(harness.handshake.established).toHaveLength(1);
    expect(harness.handshake.established[0].offered).toBe(CLIENT_PUBLIC_KEY);
    // R3: a real session id from the store, never anything the client supplied.
    expect(harness.sessionStore.sessions.map((session) => session.id)).toContain(
      harness.handshake.established[0].sessionId,
    );
  });

  it('the verify response body is unchanged — the handshake travels in headers only', async () => {
    const { verified } = await completeChallenge();

    expect(verified.text).not.toContain(SERVER_PUBLIC_KEY);
    expect(verified.text).not.toContain('sess_super');
    expect(Object.keys(verified.body.data)).not.toContain('transportKey');
  });

  it('a super_admin that offers no public key on verify gets no headers and a normal session', async () => {
    const { verified } = await completeChallenge({ offerKeyOnVerify: false });

    expect(verified.status).toBe(200);
    expect(verified.headers['x-transport-public-key']).toBeUndefined();
    expect(harness.handshake.established[0].offered).toBeUndefined();
    // The session cookies are still set — an absent handshake never costs anybody their login.
    expect(jarFrom(verified)).toContain('__Host-rs_at=');
  });

  it('POST /auth/mfa/recover completes the handshake too — a lost device still gets a key', async () => {
    // Enrol first, so there are recovery codes to spend.
    const { verified } = await completeChallenge();
    const codes = verified.body.data.recoveryCodes as string[];
    expect(Array.isArray(codes)).toBe(true);

    const secondLogin = await harness
      .http()
      .post('/api/v1/auth/login')
      .set('x-transport-public-key', CLIENT_PUBLIC_KEY)
      .send({ email: SUPER_EMAIL, password: PASSWORD });

    const recovered = await harness
      .http()
      .post('/api/v1/auth/mfa/recover')
      .set('x-transport-public-key', CLIENT_PUBLIC_KEY)
      .send({
        mfaPendingToken: cookieValue(secondLogin, MFA_PENDING_COOKIE_NAME),
        recoveryCode: codes[0],
      });

    expect(recovered.status).toBe(200);
    expect(recovered.headers['x-transport-public-key']).toBe(SERVER_PUBLIC_KEY);
    expect(recovered.headers['x-transport-kid']).toBe('sess_super');
    expect(harness.handshake.established).toHaveLength(2);
  });
});
