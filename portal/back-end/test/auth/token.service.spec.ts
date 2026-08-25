/**
 * T-011 — `TokenService`: RS256 signing, and every way a presented token can be rejected.
 *
 * This file is where TC-9, TC-10 and TC-11 actually live. `auth.e2e-spec.ts` re-runs the same
 * three attacks over real HTTP against a real server, because "the verifier rejects it" and "the
 * endpoint answers 401" are different claims and both need proving — but the forged tokens are
 * *built* here, by hand, from the same primitives an attacker would use.
 *
 * The negative cases deliberately outnumber the positive ones by a wide margin. That is the
 * right shape for a verifier: there is one way to be a valid token and a great many ways to be
 * something that merely resembles one, and a verifier is only as good as the resemblances it
 * refuses.
 */
import {
  constants as cryptoConstants,
  createHmac,
  createPublicKey,
  createSecretKey,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import {
  assertRsaKey,
  InvalidAccessTokenError,
  SigningKeyError,
  TokenService,
  type AccessTokenInput,
} from '@/modules/auth/services/token.service';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  JWT_AUDIENCE,
  JWT_ISSUER,
  JWT_MAX_LENGTH,
} from '@/modules/auth/session.constants';
import {
  fakeConfigService,
  generateForeignKeyPair,
  generateTestKeyPair,
  toEnvEscaped,
} from './support/test-keys';

const NOW = new Date('2026-08-17T10:00:00.000Z');

const CLAIMS: AccessTokenInput = {
  userId: 42,
  sessionId: '7f1c0f3a-2b8e-4a6e-9c1d-2f5b7a0e4d31',
  role: 'tenant_admin',
  countryId: 3,
  tenantId: 7,
  merchantId: null,
  rbacVersion: 1,
};

function build(overrides: Record<string, string> = {}): TokenService {
  const keys = generateTestKeyPair();
  return new TokenService(
    fakeConfigService({
      JWT_PRIVATE_KEY: keys.privateKey,
      JWT_PUBLIC_KEY: keys.publicKey,
      ...overrides,
    }),
  );
}

function b64url(value: object | string): string {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  return Buffer.from(json, 'utf8').toString('base64url');
}

/** Signs an arbitrary header/payload pair with a chosen private key — an attacker's toolkit. */
function forge(header: object, payload: object, privateKeyPem: string): string {
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signature = cryptoSign('sha256', Buffer.from(signingInput, 'ascii'), {
    key: privateKeyPem,
    padding: cryptoConstants.RSA_PKCS1_PADDING,
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}

/** The claim set a valid token carries, so a forgery can vary exactly one field at a time. */
function validPayload(service: TokenService, overrides: Record<string, unknown> = {}) {
  void service;
  const iat = Math.floor(NOW.getTime() / 1000);
  return {
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    sub: String(CLAIMS.userId),
    sid: CLAIMS.sessionId,
    role: CLAIMS.role,
    countryId: CLAIMS.countryId,
    tenantId: CLAIMS.tenantId,
    merchantId: CLAIMS.merchantId,
    rbacVersion: CLAIMS.rbacVersion,
    jti: 'a4c9e0d2-6f13-4a37-8f0e-9d5c1b7e2a48',
    iat,
    nbf: iat,
    exp: iat + ACCESS_TOKEN_TTL_SECONDS,
    ...overrides,
  };
}

function headerOf(service: TokenService, overrides: Record<string, unknown> = {}) {
  return { alg: 'RS256', typ: 'JWT', kid: service.kid, ...overrides };
}

function expectRejection(fn: () => unknown, reason: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidAccessTokenError);
    expect((error as InvalidAccessTokenError).reason).toBe(reason);
    return;
  }
  throw new Error(`expected a rejection with reason "${reason}", but nothing was thrown`);
}

describe('TokenService — key loading', () => {
  it('accepts a PEM carrying literal \\n escapes, as a .env file must', () => {
    const keys = generateTestKeyPair();
    const service = new TokenService(
      fakeConfigService({
        JWT_PRIVATE_KEY: toEnvEscaped(keys.privateKey),
        JWT_PUBLIC_KEY: toEnvEscaped(keys.publicKey),
      }),
    );

    const { token } = service.signAccessToken(CLAIMS, NOW);
    expect(service.verifyAccessToken(token, NOW).userId).toBe(CLAIMS.userId);
  });

  it('accepts a PEM wrapped in quotes, as some secret managers return it', () => {
    const keys = generateTestKeyPair();
    const service = new TokenService(
      fakeConfigService({
        JWT_PRIVATE_KEY: `"${toEnvEscaped(keys.privateKey)}"`,
        JWT_PUBLIC_KEY: `'${toEnvEscaped(keys.publicKey)}'`,
      }),
    );

    expect(service.kid).toHaveLength(16);
  });

  it('refuses to start on an unparseable private key', () => {
    const keys = generateTestKeyPair();
    expect(
      () =>
        new TokenService(
          fakeConfigService({
            JWT_PRIVATE_KEY: 'not a pem at all',
            JWT_PUBLIC_KEY: keys.publicKey,
          }),
        ),
    ).toThrow(SigningKeyError);
  });

  it('refuses to start on an unparseable public key', () => {
    const keys = generateTestKeyPair();
    expect(
      () =>
        new TokenService(
          fakeConfigService({
            JWT_PRIVATE_KEY: keys.privateKey,
            JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----',
          }),
        ),
    ).toThrow(SigningKeyError);
  });

  it('refuses a non-RSA key — this is what makes "there is no HMAC path" structural', () => {
    // An Ed25519 key is a perfectly good asymmetric key and a completely wrong one for RS256.
    const { generateKeyPairSync } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
    const ed = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    expect(
      () =>
        new TokenService(
          fakeConfigService({ JWT_PRIVATE_KEY: ed.privateKey, JWT_PUBLIC_KEY: ed.publicKey }),
        ),
    ).toThrow(/must be an RSA key/);
  });

  it('refuses an RSA key below 2048 bits', () => {
    const weak = generateTestKeyPair(1024);
    expect(
      () =>
        new TokenService(
          fakeConfigService({ JWT_PRIVATE_KEY: weak.privateKey, JWT_PUBLIC_KEY: weak.publicKey }),
        ),
    ).toThrow(/2048 is the minimum/);
  });

  it('refuses a mismatched key pair rather than booting and rejecting every token later', () => {
    const ours = generateTestKeyPair();
    const theirs = generateForeignKeyPair();

    expect(
      () =>
        new TokenService(
          fakeConfigService({
            JWT_PRIVATE_KEY: ours.privateKey,
            JWT_PUBLIC_KEY: theirs.publicKey,
          }),
        ),
    ).toThrow(/not the public half/);
  });

  it('rejects a symmetric key object outright, even though no call site can produce one', () => {
    // `createPrivateKey`/`createPublicKey` never return a secret key, so this branch is
    // unreachable from `TokenService`'s constructor today. Asserting it anyway is the point: the
    // guard's job is to hold if that ever stops being true, and an untested guard is a guess.
    const secret = createSecretKey(Buffer.alloc(32));

    expect(() => assertRsaKey(secret, 'JWT_PRIVATE_KEY')).toThrow(/a symmetric key/);
  });

  it('rejects an RSA key whose modulus length Node did not report', () => {
    // Synthetic: every RSA key Node produces carries `asymmetricKeyDetails`. The fallback exists
    // so that a runtime which omits them fails closed rather than treating "unknown" as "fine".
    const detailless = { asymmetricKeyType: 'rsa' } as unknown as KeyObject;

    expect(() => assertRsaKey(detailless, 'JWT_PUBLIC_KEY')).toThrow(/0-bit modulus/);
  });

  it('derives a stable kid from the public key', () => {
    const keys = generateTestKeyPair();
    const config = fakeConfigService({
      JWT_PRIVATE_KEY: keys.privateKey,
      JWT_PUBLIC_KEY: keys.publicKey,
    });

    expect(new TokenService(config).kid).toBe(new TokenService(config).kid);
  });
});

describe('TokenService — signing', () => {
  it('emits a three-segment RS256 token with the expected header', () => {
    const service = build();
    const { token, claims } = service.signAccessToken(CLAIMS, NOW);

    const [headerSegment] = token.split('.');
    const header = JSON.parse(Buffer.from(headerSegment, 'base64url').toString('utf8'));

    expect(token.split('.')).toHaveLength(3);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT', kid: service.kid });
    expect(claims.tokenId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('carries every claim 02-SECURITY §1 specifies, and no password-shaped extras', () => {
    const service = build();
    const { token } = service.signAccessToken(CLAIMS, NOW);
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

    expect(Object.keys(payload).sort()).toEqual(
      [
        'aud',
        'countryId',
        'exp',
        'iat',
        'iss',
        'jti',
        'merchantId',
        'nbf',
        'rbacVersion',
        'role',
        'sid',
        'sub',
        'tenantId',
      ].sort(),
    );
  });

  it('expires exactly ACCESS_TOKEN_TTL_SECONDS after issuance, with nbf equal to iat', () => {
    const service = build();
    const { token, claims } = service.signAccessToken(CLAIMS, NOW);
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

    expect(payload.exp - payload.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(payload.nbf).toBe(payload.iat);
    expect(claims.expiresAt.getTime() - claims.issuedAt.getTime()).toBe(
      ACCESS_TOKEN_TTL_SECONDS * 1000,
    );
  });

  it('gives every token a distinct jti', () => {
    const service = build();
    const first = service.signAccessToken(CLAIMS, NOW);
    const second = service.signAccessToken(CLAIMS, NOW);

    expect(first.claims.tokenId).not.toBe(second.claims.tokenId);
    expect(first.token).not.toBe(second.token);
  });
});

describe('TokenService — verification of a legitimate token', () => {
  it('round-trips every claim unchanged', () => {
    const service = build();
    const { token } = service.signAccessToken(CLAIMS, NOW);

    expect(service.verifyAccessToken(token, NOW)).toMatchObject({
      userId: 42,
      sessionId: CLAIMS.sessionId,
      role: 'tenant_admin',
      countryId: 3,
      tenantId: 7,
      merchantId: null,
      rbacVersion: 1,
    });
  });

  it('accepts a super_admin token whose whole scope triple is null', () => {
    const service = build();
    const { token } = service.signAccessToken(
      { ...CLAIMS, role: 'super_admin', countryId: null, tenantId: null, merchantId: null },
      NOW,
    );

    const claims = service.verifyAccessToken(token, NOW);
    expect(claims.role).toBe('super_admin');
    expect(claims.tenantId).toBeNull();
  });

  it('accepts the token at the last second before expiry and rejects it at expiry', () => {
    const service = build();
    const { token } = service.signAccessToken(CLAIMS, NOW);

    const oneSecondBefore = new Date(NOW.getTime() + (ACCESS_TOKEN_TTL_SECONDS - 1) * 1000);
    const atExpiry = new Date(NOW.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000);

    expect(service.verifyAccessToken(token, oneSecondBefore).userId).toBe(42);
    expectRejection(() => service.verifyAccessToken(token, atExpiry), 'expired');
  });
});

describe('TokenService — forged and malformed tokens', () => {
  it('TC-10: rejects alg:none with an empty signature', () => {
    const service = build();
    const token = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(validPayload(service))}.`;

    // Caught by the empty-segment check before the allowlist even runs — both would reject it.
    expectRejection(() => service.verifyAccessToken(token, NOW), 'malformed');
  });

  it('TC-10: rejects alg:none even when a plausible signature is attached', () => {
    const service = build();
    const header = b64url({ alg: 'none', typ: 'JWT', kid: service.kid });
    const payload = b64url(validPayload(service));
    const token = `${header}.${payload}.ZmFrZS1zaWduYXR1cmU`;

    expectRejection(() => service.verifyAccessToken(token, NOW), 'algorithm_not_allowed');
  });

  it('TC-11: rejects HS256 signed with the public key as the HMAC secret', () => {
    const keys = generateTestKeyPair();
    const service = new TokenService(
      fakeConfigService({ JWT_PRIVATE_KEY: keys.privateKey, JWT_PUBLIC_KEY: keys.publicKey }),
    );

    // The textbook algorithm-confusion attack: the "secret" is the public key, which the
    // attacker has, because it is public.
    const header = b64url({ alg: 'HS256', typ: 'JWT', kid: service.kid });
    const payload = b64url(validPayload(service, { role: 'super_admin' }));
    const signature = createHmac('sha256', keys.publicKey)
      .update(`${header}.${payload}`)
      .digest('base64url');

    expectRejection(
      () => service.verifyAccessToken(`${header}.${payload}.${signature}`, NOW),
      'algorithm_not_allowed',
    );
  });

  it('TC-11: rejects HS256 signed with the SPKI DER of the public key, the other common variant', () => {
    const keys = generateTestKeyPair();
    const service = new TokenService(
      fakeConfigService({ JWT_PRIVATE_KEY: keys.privateKey, JWT_PUBLIC_KEY: keys.publicKey }),
    );
    const der = createPublicKey(keys.publicKey).export({ type: 'spki', format: 'der' });

    const header = b64url({ alg: 'HS256', typ: 'JWT', kid: service.kid });
    const payload = b64url(validPayload(service));
    const signature = createHmac('sha256', der).update(`${header}.${payload}`).digest('base64url');

    expectRejection(
      () => service.verifyAccessToken(`${header}.${payload}.${signature}`, NOW),
      'algorithm_not_allowed',
    );
  });

  it('rejects RS512, a legitimate algorithm that is simply not on the allowlist', () => {
    const service = build();
    const keys = generateTestKeyPair();
    const token = forge(
      { alg: 'RS512', typ: 'JWT', kid: service.kid },
      validPayload(service),
      keys.privateKey,
    );

    expectRejection(() => service.verifyAccessToken(token, NOW), 'algorithm_not_allowed');
  });

  it('TC-9: rejects a token signed by a different RSA key', () => {
    const service = build();
    const foreign = generateForeignKeyPair();
    const token = forge(headerOf(service), validPayload(service), foreign.privateKey);

    expectRejection(() => service.verifyAccessToken(token, NOW), 'bad_signature');
  });

  it('rejects a token whose payload was edited after signing (TC-15 of T-013, in miniature)', () => {
    const service = build();
    const { token } = service.signAccessToken(CLAIMS, NOW);
    const [header, , signature] = token.split('.');
    const tampered = b64url(validPayload(service, { tenantId: 999 }));

    expectRejection(
      () => service.verifyAccessToken(`${header}.${tampered}.${signature}`, NOW),
      'bad_signature',
    );
  });

  it('rejects a token minted under a different kid', () => {
    const service = build();
    const token = forge(
      headerOf(service, { kid: 'someone-elses' }),
      validPayload(service),
      generateTestKeyPair().privateKey,
    );

    expectRejection(() => service.verifyAccessToken(token, NOW), 'unknown_key_id');
  });

  it('rejects a token with no kid at all', () => {
    const service = build();
    const token = forge(
      { alg: 'RS256', typ: 'JWT' },
      validPayload(service),
      generateTestKeyPair().privateKey,
    );

    expectRejection(() => service.verifyAccessToken(token, NOW), 'unknown_key_id');
  });

  it('rejects an unexpected typ header', () => {
    const service = build();
    const token = forge(
      headerOf(service, { typ: 'JWE' }),
      validPayload(service),
      generateTestKeyPair().privateKey,
    );

    expectRejection(() => service.verifyAccessToken(token, NOW), 'type_not_allowed');
  });

  it('accepts a header with no typ at all — it is optional in RFC 7515', () => {
    const keys = generateTestKeyPair();
    const service = new TokenService(
      fakeConfigService({ JWT_PRIVATE_KEY: keys.privateKey, JWT_PUBLIC_KEY: keys.publicKey }),
    );
    const token = forge({ alg: 'RS256', kid: service.kid }, validPayload(service), keys.privateKey);

    expect(service.verifyAccessToken(token, NOW).userId).toBe(42);
  });

  it('rejects a crit header rather than ignoring it (RFC 7515 §4.1.11)', () => {
    const service = build();
    const token = forge(
      headerOf(service, { crit: ['exp'] }),
      validPayload(service),
      generateTestKeyPair().privateKey,
    );

    expectRejection(() => service.verifyAccessToken(token, NOW), 'critical_header_unsupported');
  });

  it('rejects a non-string alg', () => {
    const service = build();
    const token = forge(
      { alg: 256, typ: 'JWT', kid: service.kid },
      validPayload(service),
      generateTestKeyPair().privateKey,
    );

    expectRejection(() => service.verifyAccessToken(token, NOW), 'algorithm_not_allowed');
  });

  it.each([
    ['empty', ''],
    ['one segment', 'abc'],
    ['two segments', 'abc.def'],
    ['four segments', 'a.b.c.d'],
  ])('rejects a token with %s', (_label, token) => {
    const service = build();
    expectRejection(
      () => service.verifyAccessToken(token, NOW),
      token === '' ? 'empty' : 'malformed',
    );
  });

  it('rejects a token longer than the parse ceiling before decoding anything', () => {
    const service = build();
    const oversized = `${'a'.repeat(JWT_MAX_LENGTH)}.b.c`;

    expectRejection(() => service.verifyAccessToken(oversized, NOW), 'oversized');
  });

  it('rejects standard-base64 characters, which decode leniently to the same bytes', () => {
    const service = build();
    const { token } = service.signAccessToken(CLAIMS, NOW);
    const [header, payload, signature] = token.split('.');

    expectRejection(
      () => service.verifyAccessToken(`${header}.${payload}.${signature}==`, NOW),
      'malformed',
    );
    expectRejection(() => service.verifyAccessToken(`${header}.${payload}+.x`, NOW), 'malformed');
  });

  it('rejects a header that is not JSON', () => {
    const service = build();
    const token = `${Buffer.from('{oops', 'utf8').toString('base64url')}.${b64url(
      validPayload(service),
    )}.AAAA`;

    expectRejection(() => service.verifyAccessToken(token, NOW), 'header_not_json');
  });

  it.each([
    ['null', 'null'],
    ['an array', '[1,2,3]'],
    ['a number', '42'],
  ])('rejects a header that decodes to %s', (_label, json) => {
    const service = build();
    const token = `${Buffer.from(json, 'utf8').toString('base64url')}.${b64url(
      validPayload(service),
    )}.AAAA`;

    expectRejection(() => service.verifyAccessToken(token, NOW), 'header_not_object');
  });

  it('rejects a payload that is not JSON — after the signature has already been verified', () => {
    const keys = generateTestKeyPair();
    const service = new TokenService(
      fakeConfigService({ JWT_PRIVATE_KEY: keys.privateKey, JWT_PUBLIC_KEY: keys.publicKey }),
    );

    // Genuinely signed, so the signature check passes and the payload decode is what fails.
    const header = b64url(headerOf(service));
    const payload = Buffer.from('{not json', 'utf8').toString('base64url');
    const signature = cryptoSign('sha256', Buffer.from(`${header}.${payload}`, 'ascii'), {
      key: keys.privateKey,
      padding: cryptoConstants.RSA_PKCS1_PADDING,
    }).toString('base64url');

    expectRejection(
      () => service.verifyAccessToken(`${header}.${payload}.${signature}`, NOW),
      'payload_not_json',
    );
  });

  it('rejects a payload that decodes to an array', () => {
    const keys = generateTestKeyPair();
    const service = new TokenService(
      fakeConfigService({ JWT_PRIVATE_KEY: keys.privateKey, JWT_PUBLIC_KEY: keys.publicKey }),
    );
    const header = b64url(headerOf(service));
    const payload = Buffer.from('[]', 'utf8').toString('base64url');
    const signature = cryptoSign('sha256', Buffer.from(`${header}.${payload}`, 'ascii'), {
      key: keys.privateKey,
      padding: cryptoConstants.RSA_PKCS1_PADDING,
    }).toString('base64url');

    expectRejection(
      () => service.verifyAccessToken(`${header}.${payload}.${signature}`, NOW),
      'payload_not_object',
    );
  });
});

describe('TokenService — claim assertions on an authentically-signed token', () => {
  /** Signs `overrides` with the service's *own* key, so only the claim under test can fail. */
  function signedWith(overrides: Record<string, unknown>) {
    const keys = generateTestKeyPair();
    const service = new TokenService(
      fakeConfigService({ JWT_PRIVATE_KEY: keys.privateKey, JWT_PUBLIC_KEY: keys.publicKey }),
    );
    const token = forge(headerOf(service), validPayload(service, overrides), keys.privateKey);
    return { service, token };
  }

  it.each([
    ['a foreign issuer', { iss: 'evil-portal' }, 'issuer_mismatch'],
    ['a foreign audience', { aud: 'some-other-app' }, 'audience_mismatch'],
    ['no exp', { exp: undefined }, 'exp_missing'],
    ['a non-numeric exp', { exp: 'soon' }, 'exp_missing'],
    ['no nbf', { nbf: undefined }, 'nbf_missing'],
    ['no iat', { iat: undefined }, 'iat_missing'],
    ['a non-numeric sub', { sub: 42 }, 'sub_invalid'],
    ['a sub of "0"', { sub: '0' }, 'sub_invalid'],
    ['a non-numeric-looking sub', { sub: 'admin' }, 'sub_invalid'],
    ['an empty sid', { sid: '' }, 'sid_invalid'],
    ['a non-string sid', { sid: 7 }, 'sid_invalid'],
    ['an empty jti', { jti: '' }, 'jti_invalid'],
    ['a role outside the six', { role: 'root' }, 'role_invalid'],
    ['a non-string role', { role: 3 }, 'role_invalid'],
    ['a non-numeric rbacVersion', { rbacVersion: 'v2' }, 'rbac_version_invalid'],
    ['a fractional tenantId', { tenantId: 1.5 }, 'tenantId_invalid'],
    ['a negative countryId', { countryId: -1 }, 'countryId_invalid'],
    ['a string merchantId', { merchantId: '4' }, 'merchantId_invalid'],
  ])('rejects %s', (_label, overrides, reason) => {
    const { service, token } = signedWith(overrides);
    expectRejection(() => service.verifyAccessToken(token, NOW), reason);
  });

  it('rejects a token whose nbf is still in the future', () => {
    const iat = Math.floor(NOW.getTime() / 1000);
    const { service, token } = signedWith({ nbf: iat + 60 });

    expectRejection(() => service.verifyAccessToken(token, NOW), 'not_yet_valid');
    expect(service.verifyAccessToken(token, new Date(NOW.getTime() + 60_000)).userId).toBe(42);
  });

  it('rejects an infinite exp — Number.isFinite, not just typeof number', () => {
    // JSON has no Infinity literal, so this arrives as the string "null" via JSON.stringify;
    // asserting the *type* check rather than the value is the point.
    const { service, token } = signedWith({ exp: Number.POSITIVE_INFINITY });
    expectRejection(() => service.verifyAccessToken(token, NOW), 'exp_missing');
  });
});

describe('TokenService — opaque tokens and the CSRF value', () => {
  it('generates 256 bits of CSPRNG material and stores only its SHA-256', () => {
    const service = build();
    const first = service.generateOpaqueToken();
    const second = service.generateOpaqueToken();

    expect(Buffer.from(first.raw, 'base64url')).toHaveLength(32);
    expect(first.raw).not.toBe(second.raw);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.hash).not.toContain(first.raw);
  });

  it('hashes a presented token to the same digest it stored', () => {
    const service = build();
    const token = service.generateOpaqueToken();

    expect(service.hashOpaqueToken(token.raw)).toBe(token.hash);
    expect(service.hashOpaqueToken(`${token.raw}x`)).not.toBe(token.hash);
  });

  it('derives a 128-bit CSRF value that is stable per session and differs across sessions', () => {
    const service = build();
    const a = service.csrfTokenFor('session-a');
    const b = service.csrfTokenFor('session-b');

    expect(Buffer.from(a, 'base64url')).toHaveLength(16);
    expect(service.csrfTokenFor('session-a')).toBe(a);
    expect(a).not.toBe(b);
  });

  it('derives a CSRF value that depends on the signing key, not just the session id', () => {
    const first = build();
    const other = generateForeignKeyPair();
    const second = new TokenService(
      fakeConfigService({ JWT_PRIVATE_KEY: other.privateKey, JWT_PUBLIC_KEY: other.publicKey }),
    );

    // Without the key in the derivation, a session id — which is not secret to a determined
    // attacker who can read one — would be enough to compute a valid CSRF token.
    expect(first.csrfTokenFor('same-session')).not.toBe(second.csrfTokenFor('same-session'));
  });
});
