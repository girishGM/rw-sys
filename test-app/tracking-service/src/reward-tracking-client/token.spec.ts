/**
 * T-INT-022 — `signCustomerToken`'s wire format is exactly what an independent verifier (RTS's own
 * `CustomerAuthGuard`) must accept, so this suite deliberately does NOT just re-derive the token a
 * second time via the same function under test (a change-detector that could never catch a wrong
 * wire format) — it reimplements the verification side from scratch, directly against `node:crypto`
 * and RTS's own documented wire format (`customer-auth.guard.ts`'s header: a two-segment
 * `payload.signature` base64url token, HMAC-SHA256 over the payload segment), the same way a real,
 * independent consumer (RTS itself) would. See this task's completion report for the additional,
 * real-process check (a live RTS actually accepting a token minted here).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseCustomerAuthSecret, signCustomerToken, type CustomerTokenClaims } from './token';

const SECRET = Buffer.from('a'.repeat(44), 'base64'); // 32+ real bytes, same shape as a real key

/** A standalone reimplementation of RTS's own `verifyCustomerToken` — written independently of
 * `token.ts`'s `signCustomerToken`, not imported from it, so a bug in the production signer (wrong
 * segment order, wrong digest encoding, wrong claim shape) has a real chance of being caught. */
function independentlyVerify(token: string, secret: Buffer): CustomerTokenClaims {
  const [payloadSegment, signature] = token.split('.');
  const expected = createHmac('sha256', secret).update(payloadSegment).digest('base64url');
  const a = Buffer.from(signature, 'base64url');
  const b = Buffer.from(expected, 'base64url');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('signature mismatch');
  }
  return JSON.parse(
    Buffer.from(payloadSegment, 'base64url').toString('utf8'),
  ) as CustomerTokenClaims;
}

describe('signCustomerToken', () => {
  it('produces a token an independent HMAC-SHA256 verifier accepts, with the exact claims round-tripped', () => {
    const claims: CustomerTokenClaims = {
      tenantId: 1,
      customerId: 'priya-shah',
      exp: 4_000_000_000,
    };

    const token = signCustomerToken(claims, SECRET);
    const verified = independentlyVerify(token, SECRET);

    expect(verified).toEqual(claims);
  });

  it("is a two-segment, base64url token (RTS's own wire format)", () => {
    const token = signCustomerToken({ tenantId: 1, customerId: 'x', exp: 1 }, SECRET);
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  it('signing with a different secret produces a token the independent verifier rejects', () => {
    const token = signCustomerToken({ tenantId: 1, customerId: 'x', exp: 1 }, SECRET);
    const wrongSecret = Buffer.from('b'.repeat(44), 'base64');
    expect(() => independentlyVerify(token, wrongSecret)).toThrow('signature mismatch');
  });
});

describe('parseCustomerAuthSecret', () => {
  it('decodes a valid base64 secret', () => {
    const secret = parseCustomerAuthSecret(SECRET.toString('base64'));
    expect(secret).not.toBeNull();
    expect(secret?.equals(SECRET)).toBe(true);
  });

  it('returns null for undefined/empty/whitespace-only input', () => {
    expect(parseCustomerAuthSecret(undefined)).toBeNull();
    expect(parseCustomerAuthSecret('')).toBeNull();
    expect(parseCustomerAuthSecret('   ')).toBeNull();
  });
});
