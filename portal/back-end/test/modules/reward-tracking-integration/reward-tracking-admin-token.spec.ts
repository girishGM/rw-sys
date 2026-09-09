/**
 * T-INT-030 TC-1 (unit half) — `RewardTrackingAdminTokenService`/`signRewardTrackingAdminToken`
 * in isolation.
 *
 * The most important test in this file is `verifies against an independent, hand-rolled
 * reimplementation of RTS's own verifyPortalAdminToken` below: it does not just assert this
 * module produces *a* token-shaped string, it reproduces the exact verification algorithm
 * `reward-tracking-service/src/modules/auth/portal-admin-auth.guard.ts#verifyPortalAdminToken`
 * implements (HMAC-SHA256 over the payload segment, `base64url`, constant-time compare, then
 * expiry) and proves a token minted here passes it — the "assert the observable property, not the
 * implementation string" rule `AGENT-PROTOCOL.md` §3 states explicitly, because this plan exists
 * partly due to a prior task (T-INT-002) where two services' own wire formats silently diverged
 * despite each side's own tests passing. A real, live-RTS check of the same property is also run
 * manually as part of this task's own Verification steps (step 2) and recorded in the completion
 * report, since a cross-repo import of RTS's own guard code is not available from this package.
 */
import type { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  RewardTrackingAdminSecretError,
  RewardTrackingAdminTokenService,
  loadRewardTrackingAdminSecret,
  signRewardTrackingAdminToken,
  type RewardTrackingAdminTokenClaims,
} from '@/modules/reward-tracking-integration/reward-tracking-admin-token';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';

const VALID_SECRET_B64 = Buffer.alloc(32, 7).toString('base64'); // 32 bytes, decodes cleanly

function fakeConfig(values: Record<string, unknown>): ConfigService<never, true> {
  return { get: (key: string) => values[key] } as unknown as ConfigService<never, true>;
}

const ACTOR: AuthenticatedUser = {
  userId: 1,
  sessionId: 'sess-1',
  role: 'tenant_admin',
  countryId: 5,
  tenantId: 7,
  merchantId: null,
  rbacVersion: 1,
  tokenId: 'tok-1',
  mustChangePassword: false,
};

/**
 * A byte-for-byte reimplementation of `verifyPortalAdminToken`
 * (`reward-tracking-service/src/modules/auth/portal-admin-auth.guard.ts`), written independently
 * from this file's own production code rather than importing it — proves this module's own output
 * is accepted by the real algorithm the other side of the wire runs, not merely by a symmetrical
 * bug in this file's own verifier.
 */
function independentlyVerify(
  token: string,
  secret: Buffer,
  now: Date,
): RewardTrackingAdminTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('malformed token');
  const [payloadSegment, signature] = parts;

  const expected = createHmac('sha256', secret).update(payloadSegment).digest('base64url');
  const providedBuf = Buffer.from(signature, 'base64url');
  const expectedBuf = Buffer.from(expected, 'base64url');
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    throw new Error('signature mismatch');
  }

  const claims = JSON.parse(
    Buffer.from(payloadSegment, 'base64url').toString('utf8'),
  ) as RewardTrackingAdminTokenClaims;
  if (claims.exp * 1000 <= now.getTime()) throw new Error('expired');
  return claims;
}

describe('T-INT-030 — RewardTrackingAdminTokenService / signRewardTrackingAdminToken', () => {
  it("TC-1: a token minted here verifies against an independent reimplementation of RTS's own verifyPortalAdminToken, with claims equal to the originating session's own scope", () => {
    const secret = Buffer.from(VALID_SECRET_B64, 'base64');
    const now = new Date('2026-01-01T00:00:00.000Z');
    const claims: RewardTrackingAdminTokenClaims = {
      role: ACTOR.role,
      countryId: ACTOR.countryId,
      tenantId: ACTOR.tenantId,
      merchantId: ACTOR.merchantId,
      exp: Math.floor(now.getTime() / 1000) + 60,
    };

    const token = signRewardTrackingAdminToken(claims, secret);
    const verified = independentlyVerify(token, secret, now);

    expect(verified).toEqual(claims);
  });

  it('a token minted for one role/scope is rejected by the independent verifier once forged with a different secret', () => {
    const secret = Buffer.from(VALID_SECRET_B64, 'base64');
    const wrongSecret = Buffer.alloc(32, 9);
    const now = new Date('2026-01-01T00:00:00.000Z');
    const claims: RewardTrackingAdminTokenClaims = {
      role: 'super_admin',
      countryId: null,
      tenantId: null,
      merchantId: null,
      exp: Math.floor(now.getTime() / 1000) + 60,
    };

    const token = signRewardTrackingAdminToken(claims, secret);

    expect(() => independentlyVerify(token, wrongSecret, now)).toThrow('signature mismatch');
  });

  it('an expired token is rejected by the independent verifier', () => {
    const secret = Buffer.from(VALID_SECRET_B64, 'base64');
    const mintedAt = new Date('2026-01-01T00:00:00.000Z');
    const claims: RewardTrackingAdminTokenClaims = {
      role: 'checker',
      countryId: 1,
      tenantId: 2,
      merchantId: null,
      exp: Math.floor(mintedAt.getTime() / 1000) - 1, // already expired at mint time
    };

    const token = signRewardTrackingAdminToken(claims, secret);

    expect(() => independentlyVerify(token, secret, mintedAt)).toThrow('expired');
  });

  describe('loadRewardTrackingAdminSecret', () => {
    it('throws RewardTrackingAdminSecretError when PORTAL_ADMIN_API_AUTH_SECRET is unset (fail closed, not a weaker default)', () => {
      const config = fakeConfig({ PORTAL_ADMIN_API_AUTH_SECRET: undefined });
      expect(() => loadRewardTrackingAdminSecret(config)).toThrow(RewardTrackingAdminSecretError);
    });

    it('throws RewardTrackingAdminSecretError when the decoded secret is shorter than 32 bytes', () => {
      const tooShort = Buffer.alloc(16, 1).toString('base64');
      const config = fakeConfig({ PORTAL_ADMIN_API_AUTH_SECRET: tooShort });
      expect(() => loadRewardTrackingAdminSecret(config)).toThrow(RewardTrackingAdminSecretError);
    });

    it('accepts a >= 32 byte base64 secret', () => {
      const config = fakeConfig({ PORTAL_ADMIN_API_AUTH_SECRET: VALID_SECRET_B64 });
      const secret = loadRewardTrackingAdminSecret(config);
      expect(secret.length).toBeGreaterThanOrEqual(32);
    });
  });

  describe('RewardTrackingAdminTokenService.mint', () => {
    it('mints a token whose claims are copied verbatim from AuthenticatedUser, never widened', () => {
      const service = new RewardTrackingAdminTokenService(
        fakeConfig({ PORTAL_ADMIN_API_AUTH_SECRET: VALID_SECRET_B64 }),
      );
      const now = new Date('2026-02-02T00:00:00.000Z');

      const token = service.mint(ACTOR, now);
      const secret = Buffer.from(VALID_SECRET_B64, 'base64');
      const claims = independentlyVerify(token, secret, now);

      expect(claims.role).toBe(ACTOR.role);
      expect(claims.countryId).toBe(ACTOR.countryId);
      expect(claims.tenantId).toBe(ACTOR.tenantId);
      expect(claims.merchantId).toBe(ACTOR.merchantId);
    });

    it('defaults the token TTL to 60s when REWARD_TRACKING_ADMIN_TOKEN_TTL_SECONDS is unset', () => {
      const service = new RewardTrackingAdminTokenService(
        fakeConfig({ PORTAL_ADMIN_API_AUTH_SECRET: VALID_SECRET_B64 }),
      );
      const now = new Date('2026-02-02T00:00:00.000Z');

      const token = service.mint(ACTOR, now);
      const secret = Buffer.from(VALID_SECRET_B64, 'base64');
      const claims = independentlyVerify(token, secret, now);

      expect(claims.exp).toBe(Math.floor(now.getTime() / 1000) + 60);
    });

    it('honors a configured REWARD_TRACKING_ADMIN_TOKEN_TTL_SECONDS', () => {
      const service = new RewardTrackingAdminTokenService(
        fakeConfig({
          PORTAL_ADMIN_API_AUTH_SECRET: VALID_SECRET_B64,
          REWARD_TRACKING_ADMIN_TOKEN_TTL_SECONDS: 15,
        }),
      );
      const now = new Date('2026-02-02T00:00:00.000Z');

      const token = service.mint(ACTOR, now);
      const secret = Buffer.from(VALID_SECRET_B64, 'base64');
      const claims = independentlyVerify(token, secret, now);

      expect(claims.exp).toBe(Math.floor(now.getTime() / 1000) + 15);
    });

    it('a token minted for a null-scope super_admin carries null countryId/tenantId/merchantId, never coerced to 0 or omitted', () => {
      const service = new RewardTrackingAdminTokenService(
        fakeConfig({ PORTAL_ADMIN_API_AUTH_SECRET: VALID_SECRET_B64 }),
      );
      const superAdmin: AuthenticatedUser = {
        ...ACTOR,
        role: 'super_admin',
        countryId: null,
        tenantId: null,
        merchantId: null,
      };
      const now = new Date('2026-02-02T00:00:00.000Z');

      const token = service.mint(superAdmin, now);
      const secret = Buffer.from(VALID_SECRET_B64, 'base64');
      const claims = independentlyVerify(token, secret, now);

      expect(claims.countryId).toBeNull();
      expect(claims.tenantId).toBeNull();
      expect(claims.merchantId).toBeNull();
    });
  });
});
