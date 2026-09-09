/**
 * T-INT-030 implementation note 1 — mints the short-lived, RTS-specific HMAC bearer token
 * `PortalAdminAuthGuard` (`reward-tracking-service/src/modules/auth/portal-admin-auth.guard.ts`)
 * verifies. Ported **byte-for-byte** from that guard's own `signPortalAdminToken`/
 * `verifyPortalAdminToken` wire format — its own header: "`node:crypto`'s `createHmac` +
 * `timingSafeEqual`, no JWT library" — read directly (not guessed) before writing this file:
 *
 *   payloadSegment = base64url(JSON.stringify({ role, countryId, tenantId, merchantId, exp }))
 *   signature      = base64url(HMAC-SHA256(secret, payloadSegment))
 *   token          = `${payloadSegment}.${signature}`
 *
 * This module **mints only** — it never verifies. Verification is RTS's own job, on its own side
 * of the wire, exactly as that guard's header states: "Minting this token is portal-side work...
 * flagged in the completion report for the architect to schedule as its own, portal-owned
 * integration task." This is that task.
 *
 * ### Why `RewardTrackingAdminRole` is not a new enum requiring a translation table
 *
 * Unlike the promo-code-service `bindLevel` case (`promo-code-service.client.ts`'s own header,
 * T-166, which genuinely needs a lowercase→uppercase map because the two services spell the same
 * concept differently), the six portal roles are spelled **identically** on both sides of this
 * wire — `PortalAdminAuthGuard.PORTAL_ADMIN_ROLES` is verbatim `TokenService`'s own `PORTAL_ROLES`
 * set. So this file reuses the portal's own `PortalRole` type directly rather than inventing a
 * parallel one that could silently drift from it.
 *
 * ### Trust model (implementation note 2)
 *
 * This service does **not** re-derive RBAC. It reads the caller's *already-verified*
 * `role`/`countryId`/`tenantId`/`merchantId` off `@CurrentUser()` — the same scope-triple
 * `TokenService.AccessTokenClaims` already carries, established by the portal's own
 * `JwtAuthGuard`/`RolesGuard` chain, unchanged — and re-signs it into a short-lived, narrower
 * credential for the one outbound call. Never widened, never read from a request param (R3 in
 * `project-plan/AGENT-PROTOCOL.md`).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import type { Env } from '@/config/env.schema';
import type { PortalRole } from '@/database/portal-models';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';

/** Verbatim alias of the portal's own six-role type — see this file's header for why no
 * translation table is needed between the two services. */
export type RewardTrackingAdminRole = PortalRole;

/** The wire claims this token carries — field-for-field identical to RTS's own
 * `PortalAdminTokenClaims`. `exp` is Unix seconds. */
export interface RewardTrackingAdminTokenClaims {
  readonly role: RewardTrackingAdminRole;
  readonly countryId: number | null;
  readonly tenantId: number | null;
  readonly merchantId: number | null;
  readonly exp: number;
}

const MIN_SECRET_BYTES = 32;
const ENV_VAR = 'PORTAL_ADMIN_API_AUTH_SECRET';
const DEFAULT_TTL_SECONDS = 60;

/** Thrown at construction, never at request time — the same fail-fast-on-a-missing-secret shape
 * `loadPortalAdminAuthSecret` (RTS's own guard) uses: a misconfigured deployment fails its boot,
 * not its first dashboard request. */
export class RewardTrackingAdminSecretError extends Error {}

/**
 * Reads and validates `PORTAL_ADMIN_API_AUTH_SECRET` — base64-encoded, at least
 * {@link MIN_SECRET_BYTES} bytes once decoded, **must equal the value RTS's own guard is
 * configured with**, since this is a shared secret, not a portal-only one. No default — an unset
 * or too-short value throws rather than minting a token nothing on the other end will accept.
 */
export function loadRewardTrackingAdminSecret(configService: ConfigService<Env, true>): Buffer {
  const raw = configService.get('PORTAL_ADMIN_API_AUTH_SECRET', { infer: true });
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new RewardTrackingAdminSecretError(
      `${ENV_VAR} is required (base64-encoded, >= ${MIN_SECRET_BYTES} bytes) — no default, no ` +
        "fallback. It must equal reward-tracking-service's own PORTAL_ADMIN_API_AUTH_SECRET.",
    );
  }
  const secret = Buffer.from(raw.trim(), 'base64');
  if (secret.length < MIN_SECRET_BYTES) {
    throw new RewardTrackingAdminSecretError(
      `${ENV_VAR} must decode to at least ${MIN_SECRET_BYTES} bytes (got ${secret.length}).`,
    );
  }
  return secret;
}

function hmac(payloadSegment: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(payloadSegment).digest('base64url');
}

/**
 * The wire format itself — byte-for-byte the same construction as RTS's own
 * `signPortalAdminToken`. Exported (not just used internally) so a unit test can assert the exact
 * bytes without duplicating this function's own logic a second time.
 */
export function signRewardTrackingAdminToken(
  claims: RewardTrackingAdminTokenClaims,
  secret: Buffer,
): string {
  const payloadSegment = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payloadSegment}.${hmac(payloadSegment, secret)}`;
}

@Injectable()
export class RewardTrackingAdminTokenService {
  private readonly secret: Buffer;
  private readonly ttlSeconds: number;

  constructor(config: ConfigService<Env, true>) {
    this.secret = loadRewardTrackingAdminSecret(config);
    const configured = config.get('REWARD_TRACKING_ADMIN_TOKEN_TTL_SECONDS', { infer: true });
    this.ttlSeconds =
      typeof configured === 'number' && Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_TTL_SECONDS;
  }

  /**
   * Re-issues `user`'s already-verified scope claim under RTS's own, narrower credential — see
   * this file's header, implementation note 2. Short-lived by design (`ttlSeconds`, default
   * {@link DEFAULT_TTL_SECONDS}s): this token exists only for the lifetime of one outbound
   * dashboard call, never persisted, never reused across requests.
   */
  mint(user: AuthenticatedUser, now: Date = new Date()): string {
    const claims: RewardTrackingAdminTokenClaims = {
      role: user.role,
      countryId: user.countryId,
      tenantId: user.tenantId,
      merchantId: user.merchantId,
      exp: Math.floor(now.getTime() / 1000) + this.ttlSeconds,
    };
    return signRewardTrackingAdminToken(claims, this.secret);
  }
}
