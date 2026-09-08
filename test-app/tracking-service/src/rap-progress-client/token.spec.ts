/**
 * T-INT-021 — `signProgressApiToken`'s wire format is exactly what an independent verifier (RAP's
 * own `verifyProgressApiToken`) must accept, so this suite deliberately does NOT just re-derive the
 * token a second time via the same function under test — it reimplements the verification side
 * from scratch, directly against `node:crypto` and RAP's own documented wire format
 * (`progress-api-token.ts`'s header: a two-segment `payload.signature` base64url token,
 * HMAC-SHA256 over the payload segment), the same way a real, independent consumer (RAP itself)
 * would.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  parseProgressApiAuthSecret,
  signProgressApiToken,
  type ProgressApiTokenClaims,
} from './token';

const SECRET = Buffer.from('a'.repeat(44), 'base64'); // 32+ real bytes, same shape as a real key

function independentlyVerify(token: string, secret: Buffer): ProgressApiTokenClaims {
  const [payloadSegment, signature] = token.split('.');
  const expected = createHmac('sha256', secret).update(payloadSegment).digest('base64url');
  const a = Buffer.from(signature, 'base64url');
  const b = Buffer.from(expected, 'base64url');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('signature mismatch');
  }
  return JSON.parse(
    Buffer.from(payloadSegment, 'base64url').toString('utf8'),
  ) as ProgressApiTokenClaims;
}

describe('signProgressApiToken', () => {
  it('produces a token an independent HMAC-SHA256 verifier accepts, with the exact claims round-tripped', () => {
    const claims: ProgressApiTokenClaims = {
      tenantId: 1,
      customerId: 'priya-shah',
      exp: 4_000_000_000,
    };

    const token = signProgressApiToken(claims, SECRET);
    const verified = independentlyVerify(token, SECRET);

    expect(verified).toEqual(claims);
  });

  it("is a two-segment, base64url token (RAP's own wire format)", () => {
    const token = signProgressApiToken({ tenantId: 1, customerId: 'x', exp: 1 }, SECRET);
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  it('signing with a different secret produces a token the independent verifier rejects', () => {
    const token = signProgressApiToken({ tenantId: 1, customerId: 'x', exp: 1 }, SECRET);
    const wrongSecret = Buffer.from('b'.repeat(44), 'base64');
    expect(() => independentlyVerify(token, wrongSecret)).toThrow('signature mismatch');
  });
});

describe('parseProgressApiAuthSecret', () => {
  it('decodes a valid base64 secret', () => {
    const secret = parseProgressApiAuthSecret(SECRET.toString('base64'));
    expect(secret).not.toBeNull();
    expect(secret?.equals(SECRET)).toBe(true);
  });

  it('returns null for undefined/empty/whitespace-only input', () => {
    expect(parseProgressApiAuthSecret(undefined)).toBeNull();
    expect(parseProgressApiAuthSecret('')).toBeNull();
    expect(parseProgressApiAuthSecret('   ')).toBeNull();
  });

  it('returns null for a secret shorter than 32 bytes (RAP rejects these too)', () => {
    expect(parseProgressApiAuthSecret(Buffer.from('short').toString('base64'))).toBeNull();
  });
});
