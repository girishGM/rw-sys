/**
 * T-RAP-040. Pure-logic tests for `progress-api-token.ts` — no DB, no Nest app. The e2e suite
 * (`progress-api.e2e-spec.ts`) already covers the guard's own HTTP-facing behaviour end to end;
 * this file isolates the token codec itself (round-trip, tamper detection, expiry) the same way
 * `encryption.service.spec.ts` isolates `EncryptionService` from anything DB/Nest-shaped.
 */
import { createHmac } from 'node:crypto';
import {
  InvalidProgressApiTokenError,
  loadProgressApiAuthSecret,
  signProgressApiToken,
  verifyProgressApiToken,
} from '@/modules/progress-api/progress-api-token';

/** Builds a structurally well-signed token over an arbitrary (possibly malformed) payload object
 * — used only to reach `verifyProgressApiToken`'s claims-shape validation branch, which a
 * type-checked call through `signProgressApiToken` itself could never produce. */
function signRawPayload(payload: unknown, secret: Buffer): string {
  const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(payloadSegment).digest('base64url');
  return `${payloadSegment}.${signature}`;
}

const SECRET = Buffer.alloc(32, 5);
const OTHER_SECRET = Buffer.alloc(32, 6);

describe('progress-api-token', () => {
  describe('loadProgressApiAuthSecret', () => {
    const ENV_KEY = 'PROGRESS_API_AUTH_SECRET';
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env[ENV_KEY];
    });

    afterEach(() => {
      if (saved === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = saved;
      }
    });

    it('throws when the env var is missing', () => {
      delete process.env[ENV_KEY];
      expect(() => loadProgressApiAuthSecret()).toThrow(/PROGRESS_API_AUTH_SECRET is required/);
    });

    it('throws when the decoded secret is shorter than 32 bytes', () => {
      process.env[ENV_KEY] = Buffer.alloc(16, 1).toString('base64');
      expect(() => loadProgressApiAuthSecret()).toThrow(/at least 32 bytes/);
    });

    it('returns the decoded secret when valid', () => {
      process.env[ENV_KEY] = SECRET.toString('base64');
      expect(loadProgressApiAuthSecret()).toEqual(SECRET);
    });
  });

  describe('sign/verify round trip', () => {
    it('verifies a token signed with the same secret and returns the original claims', () => {
      const claims = {
        tenantId: 42,
        customerId: 'cust-1',
        exp: Math.floor(Date.now() / 1000) + 60,
      };
      const token = signProgressApiToken(claims, SECRET);
      expect(verifyProgressApiToken(token, SECRET)).toEqual(claims);
    });

    it('rejects a token whose payload was tampered with (signature no longer matches)', () => {
      const claims = {
        tenantId: 42,
        customerId: 'cust-1',
        exp: Math.floor(Date.now() / 1000) + 60,
      };
      const token = signProgressApiToken(claims, SECRET);
      const [payload, signature] = token.split('.');
      const tamperedPayload = Buffer.from(
        JSON.stringify({ ...claims, customerId: 'cust-attacker' }),
      ).toString('base64url');
      const tampered = `${tamperedPayload}.${signature}`;
      expect(tampered).not.toBe(token);
      expect(() => verifyProgressApiToken(tampered, SECRET)).toThrow(InvalidProgressApiTokenError);
      // Sanity: the untampered payload segment really was different from the tampered one.
      expect(payload).not.toBe(tamperedPayload);
    });

    it('rejects a token signed with a different secret', () => {
      const claims = {
        tenantId: 42,
        customerId: 'cust-1',
        exp: Math.floor(Date.now() / 1000) + 60,
      };
      const token = signProgressApiToken(claims, OTHER_SECRET);
      expect(() => verifyProgressApiToken(token, SECRET)).toThrow(InvalidProgressApiTokenError);
    });

    it('rejects an expired token', () => {
      const claims = { tenantId: 42, customerId: 'cust-1', exp: Math.floor(Date.now() / 1000) - 1 };
      const token = signProgressApiToken(claims, SECRET);
      expect(() => verifyProgressApiToken(token, SECRET)).toThrow(/expired/i);
    });

    it('rejects a malformed token (wrong number of segments)', () => {
      expect(() => verifyProgressApiToken('not-a-token', SECRET)).toThrow(
        InvalidProgressApiTokenError,
      );
      expect(() => verifyProgressApiToken('a.b.c', SECRET)).toThrow(InvalidProgressApiTokenError);
    });

    it('rejects a well-signed token whose payload decodes to something other than valid claims', () => {
      const token = signRawPayload({ foo: 'bar' }, SECRET);
      expect(() => verifyProgressApiToken(token, SECRET)).toThrow(InvalidProgressApiTokenError);
      expect(() => verifyProgressApiToken(token, SECRET)).toThrow(/claims/i);
    });
  });
});
