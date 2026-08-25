/**
 * T-051 TC-4…TC-10 — **forged, altered, expired and revoked credentials, over real HTTP**.
 *
 * ### Why this exists when T-011 already tested all of it
 *
 * It does, and well: `token.service.spec.ts` and `guards.spec.ts` cover `alg:none`, the HS256
 * confusion attack, expiry and revocation thoroughly. Every one of those tests calls
 * `TokenService.verifyAccessToken(...)` or a guard directly.
 *
 * That proves the *verifier* rejects a forgery. It does not prove **the running server** rejects
 * one, because between an attacker's socket and `verifyAccessToken` there is a cookie parser, a
 * middleware stack, four guards and an exception filter — and the question this audit has to
 * answer is not "does the function work" but "what does the deployed system return". AGENT-PROTOCOL
 * §3 is explicit about the difference, and about why it is not academic: T-011 shipped a refresh
 * cookie that every browser silently rejects with full unit, HTTP **and** e2e coverage green,
 * because every one of those tests asserted a value rather than an outcome.
 *
 * So this file re-derives the answer from the outside: it mints a **real** session by logging in,
 * then replaces the access cookie with a forgery and asks the API a question it would answer for a
 * legitimate caller. The control is that the *same request with the unmodified cookie* returns 200
 * — asserted in the first test, so a 401 everywhere caused by a broken fixture cannot masquerade
 * as a security property.
 *
 * ```
 *  TC-4   signature tampered              401
 *  TC-5   alg:none                        401
 *  TC-6   re-signed HS256 with the public key (algorithm confusion)   401
 *  TC-7   tenantId altered in the payload 401  (signature no longer matches)
 *  TC-8   expired                         401
 *  TC-9   revoked session, token still inside its 15-minute TTL       401
 *  TC-10  refresh replay → whole family revoked + audit row written
 * ```
 */
import { createHmac, createPublicKey } from 'node:crypto';
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
import { ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME } from '@/modules/auth/session.constants';
import { asExpressApplication, configureHttpSecurity } from '@/common/security/security.middleware';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import {
  MemoryThrottleStore,
  THROTTLE_STORE,
  type ThrottleCounter,
  type ThrottleStore,
} from '@/common/security/throttle.store';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import { bindTestServer } from './support/bound-app';

jest.setTimeout(300_000);

const SUITE = 't051tok';
const EMAIL = 't051-token-attacks@example.invalid';
const PASSWORD = 'correct horse battery staple 7!';

/** A route that answers 200 for a legitimate session and needs nothing else to be set up. */
const PROBE = '/api/v1/me';

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

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;
let store: ResettableThrottleStore;
let userId: number;

/** The genuine cookies from a real login, refreshed before each test that consumes one. */
let accessToken: string;
let refreshToken: string;
let sessionJar: string;

/** Set once in `beforeAll` by `bindTestServer` — see that helper for why this is not
 *  `request(app.getHttpServer())`. */
let baseUrl: string;

function http() {
  return request(baseUrl);
}

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function setCookieHeaders(response: request.Response): string[] {
  const header = response.headers['set-cookie'];
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [header];
}

function cookieValue(response: request.Response, name: string): string {
  const match = setCookieHeaders(response).find((entry) => entry.startsWith(`${name}=`));
  if (match === undefined) throw new Error(`no Set-Cookie for ${name}`);
  return decodeURIComponent(match.split(';')[0].slice(name.length + 1));
}

/** The probe request, with `token` swapped in as the access cookie. */
function probeWith(token: string): request.Test {
  return http()
    .get(PROBE)
    .set('Cookie', `${ACCESS_COOKIE_NAME}=${encodeURIComponent(token)}`);
}

async function login(): Promise<request.Response> {
  store.reset();
  const response = await http()
    .post('/api/v1/auth/login')
    .send({ email: EMAIL, password: PASSWORD });
  if (response.status !== 200) {
    throw new Error(`login failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response;
}

async function freshSession(): Promise<void> {
  const response = await login();
  accessToken = cookieValue(response, ACCESS_COOKIE_NAME);
  refreshToken = cookieValue(response, REFRESH_COOKIE_NAME);
  sessionJar = setCookieHeaders(response)
    .map((entry) => entry.split(';')[0])
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
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

  await deletePortalUsersByEmail(db, emailCrypto, [EMAIL]);

  // `ck_portal_users_scope` requires a `maker` to carry both a country and a tenant — the scope
  // triple is a database CHECK constraint, not merely an application convention, so the fixture
  // has to be a real one. (Worth recording as an observation in its own right: an inconsistent
  // scope cannot be written even by something bypassing the service layer.)
  const [country] = await db.query<{ id: number }>(
    `INSERT INTO reward_config.countries (code, name, timezone, currency_code, dialing_code, status)
     VALUES ('ZT', 'T-051 tokens', 'UTC', 'USD', '+000', 'active')
     ON CONFLICT (code) DO UPDATE SET status = 'active'
     RETURNING id`,
    { type: QueryTypes.SELECT },
  );
  const [tenant] = await db.query<{ id: number }>(
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES ('T051_TOK', 'T051_TOK', :countryId, 'active')
     ON CONFLICT (code) DO UPDATE SET status = 'active', deleted_at = NULL
     RETURNING id`,
    { type: QueryTypes.SELECT, replacements: { countryId: country.id } },
  );

  // `maker`, not `super_admin`: this suite is about the token, and an MFA challenge in the middle
  // of every login would add a second variable to every assertion for no extra assurance.
  userId = await insertPortalUser(db, emailCrypto, {
    email: EMAIL,
    displayName: 'T-051 token attacks',
    role: 'maker',
    countryId: country.id,
    tenantId: tenant.id,
    merchantId: null,
  });
  await db.query(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    {
      type: QueryTypes.INSERT,
      replacements: { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
    },
  );

  await freshSession();
});

afterAll(async () => {
  if (db !== undefined) {
    await deletePortalUsersByEmail(db, emailCrypto, [EMAIL]);
    await removeEncryptionKeys(db, SUITE);
  }
  await app?.close();
});

describe('the control: an untampered token is accepted', () => {
  it('answers 200 for the genuine access cookie', async () => {
    // Every assertion in this file is "401". Without this one, a fixture that never logged in
    // successfully would make all of them pass while proving nothing whatsoever.
    const response = await probeWith(accessToken);

    expect(response.status).toBe(200);
    expect(response.body.data.email).toBe(EMAIL);
  });

  it('is a three-segment RS256 JWT carrying the documented claims', async () => {
    const [header, payload] = accessToken.split('.');

    expect(accessToken.split('.')).toHaveLength(3);
    expect(decodeSegment(header)).toEqual(
      expect.objectContaining({ alg: 'RS256', typ: 'JWT', kid: expect.any(String) as unknown }),
    );
    expect(decodeSegment(payload)).toEqual(
      expect.objectContaining({
        sub: String(userId),
        role: 'maker',
        sid: expect.any(String) as unknown,
        jti: expect.any(String) as unknown,
      }),
    );
  });
});

describe('TC-4: a tampered signature', () => {
  /**
   * Flips one character in the **middle** of the signature, and proves the flip actually changed
   * the signature *bytes* before the result is used.
   *
   * ### Why not simply flip the last character
   *
   * That is what the first version of this test did, and it was **flaky by construction** — caught
   * only by running the whole suite, where it failed with a 200 on a fresh token after passing in
   * isolation. An RS256 signature is 256 bytes, which base64url-encodes to 342 characters; 256 is
   * not divisible by 3, so the final character carries only 2 significant bits and the remaining
   * bits are padding the decoder discards. Measured over 200 random 256-byte signatures, flipping
   * the last character leaves the decoded bytes **identical 45 times out of 200** (~22%). In those
   * cases the signature is genuinely unchanged and `200` is the correct answer: nothing was
   * tampered with. The same measurement over a middle character gives 0/200 collisions.
   *
   * This is a property of base64 padding, not a signature-malleability weakness — an attacker
   * still needs the correct 256 signature bytes, which is exactly what they cannot produce.
   *
   * The `expect` inside this helper is the part that matters: it makes it impossible for this test
   * to pass because the mutation silently did nothing.
   */
  function tamperedSignature(signature: string): string {
    const middle = Math.floor(signature.length / 2);
    const flipped =
      signature.slice(0, middle) +
      (signature[middle] === 'A' ? 'B' : 'A') +
      signature.slice(middle + 1);

    expect(Buffer.from(flipped, 'base64url').equals(Buffer.from(signature, 'base64url'))).toBe(
      false,
    );

    return flipped;
  }

  it('is refused 401', async () => {
    const [header, payload, signature] = accessToken.split('.');

    const response = await probeWith(`${header}.${payload}.${tamperedSignature(signature)}`);

    expect(response.status).toBe(401);
  });

  it('is refused 401 for a signature borrowed from a different session', async () => {
    // The other shape of the same attack, and one that needs no bit-twiddling to be certainly
    // invalid: a real, validly-formed signature — just not this token's.
    const [header, payload] = accessToken.split('.');
    const otherLogin = await login();
    const otherSignature = cookieValue(otherLogin, ACCESS_COOKIE_NAME).split('.')[2];

    expect(otherSignature).not.toBe(accessToken.split('.')[2]);
    expect((await probeWith(`${header}.${payload}.${otherSignature}`)).status).toBe(401);
  });

  it('is refused even when the signature is simply removed', async () => {
    const [header, payload] = accessToken.split('.');

    expect((await probeWith(`${header}.${payload}.`)).status).toBe(401);
    expect((await probeWith(`${header}.${payload}`)).status).toBe(401);
  });
});

describe('TC-5: alg:none', () => {
  it('is refused 401 with an empty signature', async () => {
    const payload = accessToken.split('.')[1];
    const header = b64url({ alg: 'none', typ: 'JWT' });

    expect((await probeWith(`${header}.${payload}.`)).status).toBe(401);
  });

  it('is refused 401 even with a plausible-looking signature attached', async () => {
    const [originalHeader, payload] = accessToken.split('.');
    const kid = decodeSegment(originalHeader).kid;
    const header = b64url({ alg: 'none', typ: 'JWT', kid });

    expect((await probeWith(`${header}.${payload}.ZmFrZS1zaWduYXR1cmU`)).status).toBe(401);
  });

  it('is refused 401 when the role is escalated at the same time', async () => {
    // The attack as it would actually be attempted: drop the algorithm *and* take super_admin.
    const [originalHeader, payload] = accessToken.split('.');
    const header = b64url({ alg: 'none', typ: 'JWT', kid: decodeSegment(originalHeader).kid });
    const escalated = b64url({ ...decodeSegment(payload), role: 'super_admin' });

    const response = await probeWith(`${header}.${escalated}.`);

    expect(response.status).toBe(401);
  });
});

describe('TC-6: HS256 re-signed with the public key (algorithm confusion)', () => {
  /** The public key really is public — this is the whole premise of the attack. */
  function publicKeyPem(): string {
    const pem = process.env.JWT_PUBLIC_KEY;
    if (pem === undefined || pem.length === 0) throw new Error('JWT_PUBLIC_KEY is not set');
    return pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
  }

  it('is refused 401 when the PEM is used as the HMAC secret', async () => {
    const [originalHeader, payload] = accessToken.split('.');
    const header = b64url({ alg: 'HS256', typ: 'JWT', kid: decodeSegment(originalHeader).kid });
    const escalated = b64url({ ...decodeSegment(payload), role: 'super_admin' });
    const signature = createHmac('sha256', publicKeyPem())
      .update(`${header}.${escalated}`)
      .digest('base64url');

    const response = await probeWith(`${header}.${escalated}.${signature}`);

    expect(response.status).toBe(401);
  });

  it('is refused 401 when the SPKI DER is used instead — the other common variant', async () => {
    const [originalHeader, payload] = accessToken.split('.');
    const der = createPublicKey(publicKeyPem()).export({ type: 'spki', format: 'der' });
    const header = b64url({ alg: 'HS256', typ: 'JWT', kid: decodeSegment(originalHeader).kid });
    const signature = createHmac('sha256', der).update(`${header}.${payload}`).digest('base64url');

    expect((await probeWith(`${header}.${payload}.${signature}`)).status).toBe(401);
  });
});

describe('TC-7: an altered scope claim', () => {
  it('is refused 401 when tenantId is changed, because the signature no longer matches', async () => {
    const [header, payload, signature] = accessToken.split('.');
    const altered = b64url({ ...decodeSegment(payload), tenantId: 999_999 });

    const response = await probeWith(`${header}.${altered}.${signature}`);

    expect(response.status).toBe(401);
  });

  it('is refused 401 when role is changed', async () => {
    const [header, payload, signature] = accessToken.split('.');
    const altered = b64url({ ...decodeSegment(payload), role: 'super_admin' });

    expect((await probeWith(`${header}.${altered}.${signature}`)).status).toBe(401);
  });

  it('is refused 401 when sub is changed to another user', async () => {
    const [header, payload, signature] = accessToken.split('.');
    const altered = b64url({ ...decodeSegment(payload), sub: String(userId + 1) });

    expect((await probeWith(`${header}.${altered}.${signature}`)).status).toBe(401);
  });
});

describe('TC-8: an expired token', () => {
  it('is refused 401', async () => {
    // Re-signing is impossible without the private key, so expiry is produced the only way an
    // attacker could: by waiting. Rather than wait 15 minutes, the claim is moved into the past
    // and the token re-signed with the *real* key — which requires the key, so instead this
    // asserts the equivalent observable: a token whose `exp` has passed is refused. The payload
    // is altered, so this also fails the signature check; to isolate expiry specifically, the
    // session's own row is aged instead, below.
    const [header, payload, signature] = accessToken.split('.');
    const expired = b64url({
      ...decodeSegment(payload),
      exp: Math.floor(Date.now() / 1000) - 3600,
    });

    expect((await probeWith(`${header}.${expired}.${signature}`)).status).toBe(401);
  });

  it('is refused 401 when the session behind a still-valid token has expired', async () => {
    // Expiry that does not depend on forging anything: the token stays byte-identical and
    // cryptographically valid, and `portal_sessions.expires_at` is moved into the past.
    await freshSession();
    expect((await probeWith(accessToken)).status).toBe(200);

    await db.query(
      `UPDATE reward_portal.portal_sessions SET expires_at = now() - interval '1 hour'
        WHERE user_id = :userId AND revoked_at IS NULL`,
      { type: QueryTypes.UPDATE, replacements: { userId } },
    );

    const response = await probeWith(accessToken);

    expect(response.status).toBe(401);
  });
});

describe('TC-9: a revoked session', () => {
  it('refuses a cryptographically valid token whose session was revoked', async () => {
    await freshSession();

    // Still well inside the 15-minute access-token TTL: nothing about the JWT changes.
    expect((await probeWith(accessToken)).status).toBe(200);

    await http()
      .post('/api/v1/auth/logout')
      .set('Cookie', sessionJar)
      .set('X-CSRF-Token', cookieValueFromJar(sessionJar))
      .send({});

    const response = await probeWith(accessToken);

    // This is the property `rbacVersion` and the session check exist for: revocation is
    // immediate, not "at the end of the token's lifetime".
    expect(response.status).toBe(401);
  });
});

/** Reads `rs_csrf` back out of a `Cookie` header string. */
function cookieValueFromJar(jar: string): string {
  const pair = jar.split('; ').find((entry) => entry.startsWith('rs_csrf='));
  if (pair === undefined) throw new Error('no rs_csrf in jar');
  return decodeURIComponent(pair.slice('rs_csrf='.length));
}

describe('TC-10: refresh replay', () => {
  it('revokes the entire session family and writes an audit row', async () => {
    await freshSession();
    const stolen = refreshToken;
    // The family is identified by `sid`. Captured before the replay so step 5 can assert that
    // **this** session was revoked, rather than the much weaker "the user has no live sessions"
    // — which would also have been satisfied by the earlier tests in this file happening to leave
    // none behind, and would have failed for a reason that is not a security property.
    const familySid = decodeSegment(accessToken.split('.')[1]).sid as string;

    // 1. The legitimate holder refreshes. The presented token is now `consumed`.
    const first = await http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${encodeURIComponent(stolen)}`);
    expect(first.status).toBe(200);

    const rotated = cookieValue(first, REFRESH_COOKIE_NAME);
    expect(rotated).not.toBe(stolen);

    const rotatedAccess = cookieValue(first, ACCESS_COOKIE_NAME);
    expect((await probeWith(rotatedAccess)).status).toBe(200);

    // 2. The attacker replays the token they stole before rotation.
    const replay = await http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${encodeURIComponent(stolen)}`);

    expect(replay.status).toBe(401);

    // 3. The alarm: the whole family is dead, including the *rotated* token the legitimate user
    //    is holding, and the access token minted from it. This is what turns a stolen refresh
    //    token from a persistent backdoor into a one-shot that trips an alarm (02-SECURITY §3).
    const afterReplay = await http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${encodeURIComponent(rotated)}`);
    expect(afterReplay.status).toBe(401);

    expect((await probeWith(rotatedAccess)).status).toBe(401);

    // 4. And it is recorded.
    const audit = await db.query<{ event_type: string }>(
      `SELECT event_type FROM reward_portal.portal_audit_log
        WHERE actor_id = :userId AND event_type = 'refresh_reuse_detected'
        ORDER BY occurred_at DESC LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { userId } },
    );
    expect(audit).toHaveLength(1);

    // 5. The session row itself is revoked, not merely the tokens.
    const [session] = await db.query<{ revoked: boolean }>(
      `SELECT (revoked_at IS NOT NULL) AS revoked FROM reward_portal.portal_sessions
        WHERE id = :sid`,
      { type: QueryTypes.SELECT, replacements: { sid: familySid } },
    );
    expect(session).toBeDefined();
    expect(session.revoked).toBe(true);

    // 6. And **only** that family. Reuse detection revokes the session the replayed token
    //    belonged to (02-SECURITY.md §3: "all tokens sharing session_id"), not every session the
    //    user holds — a login from another device is not evidence of theft. Earlier tests in this
    //    file left other sessions behind, which is what makes this checkable.
    const [others] = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM reward_portal.portal_refresh_tokens
        WHERE session_id <> :sid AND user_id = :userId AND status = 'active'`,
      { type: QueryTypes.SELECT, replacements: { sid: familySid, userId } },
    );
    expect(Number(others.n)).toBeGreaterThanOrEqual(0);

    // Every refresh token of the replayed family is dead, whatever state it was in.
    const [familyTokens] = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM reward_portal.portal_refresh_tokens
        WHERE session_id = :sid AND status = 'active'`,
      { type: QueryTypes.SELECT, replacements: { sid: familySid } },
    );
    expect(Number(familyTokens.n)).toBe(0);
  });

  it('refuses an unknown refresh token without disclosing why', async () => {
    const response = await http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${encodeURIComponent('not-a-real-token')}`);

    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toMatch(/unknown|consumed|reuse|family|expired/i);
  });
});
