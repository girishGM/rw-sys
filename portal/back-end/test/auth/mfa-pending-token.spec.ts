/**
 * T-055 — the `MFA_PENDING` credential itself.
 *
 * The properties asserted here are the ones implementation note 4 states, tested as properties
 * rather than as behaviours of a happy path: no `sid` anywhere in the token, a five-minute life
 * the holder cannot extend, a MAC that fails for every alteration, and one undifferentiated
 * rejection for every kind of bad input.
 */
import { createHmac, createPrivateKey, hkdfSync } from 'node:crypto';
import { MfaPendingTokenService } from '@/modules/auth/services/mfa-pending-token.service';
import { SigningKeyError } from '@/modules/auth/services/token.service';
import {
  MFA_PENDING_TOKEN_MAX_LENGTH,
  MFA_PENDING_TOKEN_VERSION,
  MFA_PENDING_TTL_SECONDS,
} from '@/modules/auth/mfa.constants';
import {
  fakeConfigService,
  generateForeignKeyPair,
  generateTestKeyPair,
} from './support/test-keys';

const NOW = new Date('2026-08-18T10:00:00.000Z');

function build(privateKey: string = generateTestKeyPair().privateKey): MfaPendingTokenService {
  const keys = generateTestKeyPair();
  return new MfaPendingTokenService(
    fakeConfigService({ JWT_PRIVATE_KEY: privateKey, JWT_PUBLIC_KEY: keys.publicKey }),
  );
}

/**
 * Builds a token with an arbitrary payload and a **valid** MAC, by deriving the same key the
 * service derives (HKDF-SHA256 over the PKCS#8 DER, `info = 'mfa-pending-token'`).
 *
 * This duplicates four lines of the implementation, which is normally the thing to avoid in a
 * test — here it is the only way to reach the payload-validation branches at all, because a
 * payload the service would refuse to *mint* can only arrive with a signature the service would
 * accept if the test can sign one. The assertion is still about the production code: what it
 * rejects.
 */
function forgePendingToken(privateKeyPem: string, payloadJson: string): string {
  const der = createPrivateKey(privateKeyPem).export({ type: 'pkcs8', format: 'der' });
  const key = Buffer.from(
    hkdfSync('sha256', der, Buffer.from('reward-portal/mfa', 'utf8'), 'mfa-pending-token', 32),
  );

  const body = `${MFA_PENDING_TOKEN_VERSION}.${Buffer.from(payloadJson, 'utf8').toString('base64url')}`;
  const signature = createHmac('sha256', key).update(body, 'utf8').digest('base64url');
  return `${body}.${signature}`;
}

/** Rebuilds a token with a tampered payload, keeping the original signature. */
function withPayload(token: string, mutate: (payload: Record<string, unknown>) => void): string {
  const [version, payloadSegment, signature] = token.split('.');
  const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  mutate(payload);
  const rewritten = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${version}.${rewritten}.${signature}`;
}

describe('MfaPendingTokenService.mint', () => {
  it('produces a versioned three-part token carrying the user and the enrolment state', () => {
    const service = build();
    const token = service.mint({ userId: 42, enrolled: false }, NOW);

    expect(token.split('.')).toHaveLength(3);
    expect(token.startsWith(`${MFA_PENDING_TOKEN_VERSION}.`)).toBe(true);

    const claims = service.verify(token, NOW);
    expect(claims).toEqual({
      userId: 42,
      enrolled: false,
      expiresAt: new Date(NOW.getTime() + MFA_PENDING_TTL_SECONDS * 1000),
    });
  });

  it('carries no session id — the property implementation note 4 turns on', () => {
    const service = build();
    const token = service.mint({ userId: 42, enrolled: true }, NOW);
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

    expect(Object.keys(payload).sort()).toEqual(['e', 'exp', 'iat', 'n', 'u']);
    expect(JSON.stringify(payload)).not.toContain('sid');
  });

  it('mints a distinct token every time, even within the same second', () => {
    const service = build();
    const first = service.mint({ userId: 1, enrolled: false }, NOW);
    const second = service.mint({ userId: 1, enrolled: false }, NOW);

    expect(first).not.toBe(second);
    // Both still verify: the nonce changes the token, not its meaning.
    expect(service.verify(first, NOW)?.userId).toBe(1);
    expect(service.verify(second, NOW)?.userId).toBe(1);
  });

  it('stays well inside the length ceiling it enforces on the way back in', () => {
    const service = build();
    expect(service.mint({ userId: 2_000_000_000, enrolled: true }, NOW).length).toBeLessThan(
      MFA_PENDING_TOKEN_MAX_LENGTH,
    );
  });
});

describe('MfaPendingTokenService.verify', () => {
  it('rejects the token one second after it expires, and accepts it one second before', () => {
    const service = build();
    const token = service.mint({ userId: 7, enrolled: true }, NOW);
    const expiry = NOW.getTime() + MFA_PENDING_TTL_SECONDS * 1000;

    expect(service.verify(token, new Date(expiry - 1000))).not.toBeNull();
    // `<=`: dead *at* the expiry second, as `TokenService` treats `exp`.
    expect(service.verify(token, new Date(expiry))).toBeNull();
    expect(service.verify(token, new Date(expiry + 1000))).toBeNull();
  });

  it('rejects a token whose payload was edited to extend its life or change its user', () => {
    const service = build();
    const token = service.mint({ userId: 7, enrolled: false }, NOW);

    const longerLife = withPayload(token, (payload) => {
      payload.exp = Number(payload.exp) + 86_400;
    });
    const otherUser = withPayload(token, (payload) => {
      payload.u = 8;
    });
    const claimsEnrolled = withPayload(token, (payload) => {
      payload.e = true;
    });

    expect(service.verify(longerLife, NOW)).toBeNull();
    expect(service.verify(otherUser, NOW)).toBeNull();
    expect(service.verify(claimsEnrolled, NOW)).toBeNull();
  });

  it('rejects a token minted under a different signing key', () => {
    const mine = build();
    const theirs = build(generateForeignKeyPair().privateKey);

    expect(mine.verify(theirs.mint({ userId: 7, enrolled: true }, NOW), NOW)).toBeNull();
    expect(theirs.verify(mine.mint({ userId: 7, enrolled: true }, NOW), NOW)).toBeNull();
  });

  it('rejects an altered signature, including a truncated one', () => {
    const service = build();
    const token = service.mint({ userId: 7, enrolled: true }, NOW);
    const [version, payload, signature] = token.split('.');

    expect(service.verify(`${version}.${payload}.${signature.slice(0, -1)}`, NOW)).toBeNull();
    expect(service.verify(`${version}.${payload}.AAAA${signature.slice(4)}`, NOW)).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['not three parts', 'mfa1.abc'],
    ['four parts', 'mfa1.abc.def.ghi'],
    ['wrong version', 'mfa2.abc.def'],
    ['non-base64url payload', 'mfa1.not base64!.abc'],
    ['non-base64url signature', 'mfa1.YWJj.not base64!'],
    ['padded base64', 'mfa1.YWJj=.YWJj'],
    ['garbage', 'this is not a token at all'],
  ])('returns null for a token that is %s', (_label, token) => {
    expect(build().verify(token, NOW)).toBeNull();
  });

  it('refuses an oversized token before doing any work on it', () => {
    expect(build().verify('a'.repeat(MFA_PENDING_TOKEN_MAX_LENGTH + 1), NOW)).toBeNull();
  });

  it.each([
    ['JSON that is not an object', 'null'],
    ['an array', '[]'],
    ['a bare string', '"a string"'],
    ['not JSON at all', 'nonsense'],
    ['a zero user id', '{"u":0,"e":true,"iat":1,"exp":9999999999}'],
    ['a negative user id', '{"u":-3,"e":true,"iat":1,"exp":9999999999}'],
    ['a non-integer user id', '{"u":1.5,"e":true,"iat":1,"exp":9999999999}'],
    ['a missing user id', '{"e":true,"iat":1,"exp":9999999999}'],
    ['a non-boolean enrolled flag', '{"u":1,"e":"yes","iat":1,"exp":9999999999}'],
    ['a missing iat', '{"u":1,"e":true,"exp":9999999999}'],
    ['a non-finite exp', '{"u":1,"e":true,"iat":1,"exp":null}'],
  ])('rejects a **correctly signed** token carrying %s', (_label, payloadJson) => {
    // Forged with this process's own derived key — the same technique `token.service.spec.ts`
    // uses for JWTs, and for the same reason: these payloads model a token minted by an older or
    // buggier build of this service, not an attack. The MAC is genuinely valid, so a `verify`
    // that trusted the signature alone would accept every one of them.
    const { privateKey, publicKey } = generateTestKeyPair();
    const service = new MfaPendingTokenService(
      fakeConfigService({ JWT_PRIVATE_KEY: privateKey, JWT_PUBLIC_KEY: publicKey }),
    );

    expect(service.verify(forgePendingToken(privateKey, payloadJson), NOW)).toBeNull();
  });

  it('refuses to construct with an unusable signing key rather than starting weak', () => {
    expect(() => build('not a pem')).toThrow(SigningKeyError);
  });
});

describe('the derived key', () => {
  it('is stable across instances built from the same PEM, however the env escaped it', () => {
    const { privateKey, publicKey } = generateTestKeyPair();
    const plain = new MfaPendingTokenService(
      fakeConfigService({ JWT_PRIVATE_KEY: privateKey, JWT_PUBLIC_KEY: publicKey }),
    );
    const escaped = new MfaPendingTokenService(
      fakeConfigService({
        // The two shapes a secret manager or `.env` file produces: `\n` escapes, and quotes.
        JWT_PRIVATE_KEY: `"${privateKey.replace(/\n/g, '\\n')}"`,
        JWT_PUBLIC_KEY: publicKey,
      }),
    );

    const token = plain.mint({ userId: 3, enrolled: true }, NOW);
    expect(escaped.verify(token, NOW)?.userId).toBe(3);
  });
});
