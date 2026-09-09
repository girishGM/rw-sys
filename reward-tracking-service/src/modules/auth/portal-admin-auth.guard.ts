/**
 * T-RTS-032 — auth guard for the portal admin API (T-RTS-031: campaign/merchant/tenant/country
 * summaries + alerts, gated to Merchant/Tenant/Country Admin/Maker/Checker/Super Admin).
 *
 * ### Resolving `brain-storm/05-INTEGRATION-AND-OPEN-QUESTIONS.md` §5
 *
 * That open question assumed "a Merchant/Tenant/Country Admin's JWT already carries claims this
 * service can check against `merchant_code`/`tenant_id`/`country_code`" and asked for "a direct
 * read of the portal's auth module before finalizing". Done — files read:
 * `portal/back-end/src/modules/auth/services/token.service.ts`,
 * `portal/back-end/src/modules/auth/guards/jwt-auth.guard.ts`,
 * `portal/back-end/src/modules/auth/auth.cookies.ts`, `project-plan/00-ARCHITECTURE.md` §5.1.
 *
 * **The real claim shape** (`TokenService.AccessTokenClaims`, `project-plan/00-ARCHITECTURE.md`
 * §5.1's "scope triple"): `role` is one of exactly six values — `super_admin`, `country_admin`,
 * `tenant_admin`, `maker`, `checker`, `merchant` — plus `countryId`/`tenantId`/`merchantId`, each
 * `number | null`, where **`null` means "every value in that dimension"**, never "none":
 *
 * | Role | `countryId` | `tenantId` | `merchantId` |
 * |---|---|---|---|
 * | `super_admin`   | `null` (all) | `null` (all) | `null` |
 * | `country_admin` | set          | `null` (all) | `null` |
 * | `tenant_admin`  | set          | set          | `null` |
 * | `maker`         | set          | set          | `null` |
 * | `checker`       | set          | set          | `null` |
 * | `merchant`      | set          | set          | **set** |
 *
 * **Which model applies — verify the portal's own JWT directly, or a separate internal-service
 * token?** Verifying the portal's own token directly is **not viable, structurally**, not just
 * inconvenient:
 *
 *  1. `jwt-auth.guard.ts`'s own header is explicit that the access token travels **only** in the
 *     `__Host-rs_at` cookie — "There is deliberately no `Authorization: Bearer` fallback" — and
 *     that cookie is `HttpOnly` (`auth.cookies.ts`'s `ACCESS_COOKIE`), so no browser-side
 *     JavaScript can ever read its value to attach it to a cross-origin request by hand.
 *  2. The cookie is `__Host-`-prefixed with **no `Domain` attribute** and `SameSite=Strict`
 *     (`auth.cookies.ts` `buildSetCookie` — "No `Domain` attribute, ever: `__Host-` cookies are
 *     rejected by the browser if one is present"), so even automatic browser attachment is
 *     confined to the portal's own exact origin. A browser calling this service's own,
 *     separately-hosted origin structurally cannot present this cookie at all.
 *  3. `jwt-auth.guard.ts`'s own header states the intended precedent for exactly this situation:
 *     *"If a machine-to-machine caller ever needs access, it gets its own credential type and its
 *     own guard ... not a second door into this one."*
 *  4. `brain-storm/04-API-DESIGN.md` §2.1 independently confirms the resulting trust model: "this
 *     service trusts the caller's already-verified tenant/campaign grant, it does not re-derive
 *     RBAC from scratch" — i.e. this service is not meant to re-implement the portal's own
 *     permission-table lookups (`role_entity_permissions`, `assertRole`), only to trust an
 *     already-authorized claim handed to it.
 *
 * **Resolution: this service sits behind the portal.** The portal's own backend authenticates the
 * browser session exactly as it does today (its own `JwtAuthGuard`/`RolesGuard` chain, unchanged —
 * R0 forbids touching it), then — when it needs to call this service on that admin's behalf —
 * mints a short-lived, narrow, **RTS-specific** bearer token carrying the same claim shape
 * (`role`/`countryId`/`tenantId`/`merchantId`) confirmed above, over a shared secret. This is not
 * a novel invention: it mirrors two precedents already shipped elsewhere in this exact repo
 * family for the identical shape of problem:
 *  - `promo-code-service`'s `InternalServiceTokenGuard` — "a shared internal service token
 *    (bearer, rotated independently of any portal user/session credential)" for the
 *    portal-backend-to-downstream-service call.
 *  - `realtime-activity-processing-service`'s `ProgressApiAuthGuard`/`progress-api-token.ts` —
 *    which investigated this *exact* question for a different, customer-facing surface, reached
 *    the identical "neither existing convention transfers" conclusion, and built a bespoke,
 *    `node:crypto`-only HMAC bearer token for it. This guard follows the same wire format for
 *    consistency across the repo, adapted to admin claims instead of customer claims.
 *
 * **Minting this token is portal-side work and is out of this task's scope** (R0 — this task may
 * only read `portal/`, never edit it; ARCHITECTURE.md §7 forbids creating a file there from this
 * plan). Flagged in the completion report for the architect to schedule as its own, portal-owned
 * integration task, same as `AGENT-PROTOCOL.md` R0's "a real integration need on that side is
 * filed as that project's own task" directs. Until that lands, `signPortalAdminToken` (below) is
 * this test suite's own stand-in issuer — exactly the same "exported purely so tests don't
 * hand-roll the wire format a second time" reasoning `progress-api-token.ts` already documents.
 *
 * No JWT library dependency is added (none exists in this workspace, and the portal's own
 * `TokenService` already sets the "implement the narrow primitive over `node:crypto`, not a
 * general-purpose decoder" precedent this file follows for the same reasons).
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/** The six portal roles, verbatim from `TokenService`'s own `PORTAL_ROLES` set. */
export const PORTAL_ADMIN_ROLES = [
  'super_admin',
  'country_admin',
  'tenant_admin',
  'maker',
  'checker',
  'merchant',
] as const;

export type PortalAdminRole = (typeof PORTAL_ADMIN_ROLES)[number];

/** The wire claims this guard verifies. `exp` is Unix seconds. */
export interface PortalAdminTokenClaims {
  readonly role: PortalAdminRole;
  readonly countryId: number | null;
  readonly tenantId: number | null;
  readonly merchantId: number | null;
  readonly exp: number;
}

/** What lands on `request.portalAdmin` once verified — the claims minus the expiry. */
export type PortalAdminAuthContext = Omit<PortalAdminTokenClaims, 'exp'>;

export interface RequestWithPortalAdmin extends Request {
  portalAdmin: PortalAdminAuthContext;
}

export class InvalidPortalAdminTokenError extends Error {}

const BEARER_PREFIX = 'Bearer ';
const MIN_SECRET_BYTES = 32;
const ENV_VAR = 'PORTAL_ADMIN_API_AUTH_SECRET';

/**
 * Read directly from `process.env`, not `ConfigService`/`src/config/config.schema.ts` — that
 * shared bootstrap schema belongs to T-RTS-001's own file scope (see that file's own header:
 * "a later Wave 1+ var that some *other* module reads directly from `process.env` ... is
 * intentionally NOT folded in here"), exactly the precedent `promo-code-service`'s
 * `internal-service-token.guard.ts` and RAP's `progress-api-token.ts` both already followed for
 * the identical reason. Throws synchronously at guard-construction time (fail fast, R11/R12 — no
 * default, no silent accept-everything fallback) so a missing secret fails boot, not the first
 * real request.
 */
export function loadPortalAdminAuthSecret(): Buffer {
  const raw = process.env[ENV_VAR]?.trim();
  if (!raw) {
    throw new Error(
      `${ENV_VAR} is required (base64-encoded, >= ${MIN_SECRET_BYTES} bytes) — no default, no ` +
        'fallback (AGENT-PROTOCOL.md R12).',
    );
  }
  const secret = Buffer.from(raw, 'base64');
  if (secret.length < MIN_SECRET_BYTES) {
    throw new Error(
      `${ENV_VAR} must decode to at least ${MIN_SECRET_BYTES} bytes (got ${secret.length}).`,
    );
  }
  return secret;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `null`, or a positive integer — the scope-triple shape confirmed above. Anything else is
 * forgery, mirroring `TokenService.assertNullableId`'s own reasoning. */
function isNullableId(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value > 0);
}

function parseClaims(value: unknown): PortalAdminTokenClaims {
  if (
    !isPlainObject(value) ||
    typeof value.role !== 'string' ||
    !(PORTAL_ADMIN_ROLES as readonly string[]).includes(value.role) ||
    !isNullableId(value.countryId) ||
    !isNullableId(value.tenantId) ||
    !isNullableId(value.merchantId) ||
    typeof value.exp !== 'number'
  ) {
    throw new InvalidPortalAdminTokenError('Malformed token claims');
  }
  return {
    role: value.role as PortalAdminRole,
    countryId: value.countryId,
    tenantId: value.tenantId,
    merchantId: value.merchantId,
    exp: value.exp,
  };
}

function hmac(payloadSegment: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(payloadSegment).digest('base64url');
}

/**
 * Issuance is the portal's own concern in production (see this file's header) — exported purely
 * so tests (and any future local-issuer tooling) don't hand-roll the wire format a second time,
 * same as `progress-api-token.ts`'s own `signProgressApiToken`.
 */
export function signPortalAdminToken(claims: PortalAdminTokenClaims, secret: Buffer): string {
  const payloadSegment = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payloadSegment}.${hmac(payloadSegment, secret)}`;
}

/**
 * Verifies the HMAC (constant-time — no early-exit timing side channel) and the expiry, in that
 * order, then the claim shape. Throws {@link InvalidPortalAdminTokenError} for every failure mode;
 * the guard maps all of them to the same generic `401` (implementation note 3: never a
 * distinguishable "exists but forbidden" response).
 */
export function verifyPortalAdminToken(
  token: string,
  secret: Buffer,
  now: Date = new Date(),
): PortalAdminTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw new InvalidPortalAdminTokenError('Malformed token');
  }
  const [payloadSegment, signature] = parts;

  const expectedSignature = hmac(payloadSegment, secret);
  const provided = Buffer.from(signature, 'base64url');
  const expected = Buffer.from(expectedSignature, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new InvalidPortalAdminTokenError('Signature mismatch');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidPortalAdminTokenError('Malformed token payload');
  }
  const claims = parseClaims(parsed);

  if (claims.exp * 1000 <= now.getTime()) {
    throw new InvalidPortalAdminTokenError('Token expired');
  }
  return claims;
}

export const REQUIRE_PORTAL_ROLES_KEY = 'rts:requirePortalAdminRoles';

/**
 * Declares which of the six portal roles may reach a route, mirroring the portal's own
 * `@Roles(...)` (`common/rbac`). At least one role is required — an empty list would deny
 * everyone silently, which `RequirePortalRoles()` refuses at decoration time rather than at
 * request time, the same defensive posture `assertRole`'s own empty-list guard takes.
 */
export function RequirePortalRoles(
  ...roles: readonly PortalAdminRole[]
): MethodDecorator & ClassDecorator {
  if (roles.length === 0) {
    throw new Error('RequirePortalRoles() requires at least one role.');
  }
  return SetMetadata(REQUIRE_PORTAL_ROLES_KEY, roles);
}

export interface PortalAdminScopeRequirement {
  readonly tenantId?: number;
  readonly merchantId?: number;
  readonly countryId?: number;
}

/**
 * Service-layer defense in depth, mirroring the portal's own `assertRole` precedent
 * (`portal/back-end/src/common/rbac/assert-role.ts`): callable from T-RTS-031's service methods
 * independently of whatever the guard/decorator layer already checked, so a misconfigured route
 * decorator (or a future caller of the service method that bypasses the HTTP guard entirely)
 * cannot become a cross-tenant/merchant/country data leak. Encodes the scope-triple table in this
 * file's own header: a `null` claim field means "every value in that dimension", so it never
 * fails the comparison — only a concrete, mismatched value does.
 */
export function assertPortalAdminScope(
  claims: PortalAdminAuthContext,
  required: PortalAdminScopeRequirement,
): void {
  if (
    required.tenantId !== undefined &&
    claims.tenantId !== null &&
    claims.tenantId !== required.tenantId
  ) {
    throw new ForbiddenException('Token is not authorized for this tenant');
  }
  if (
    required.merchantId !== undefined &&
    claims.merchantId !== null &&
    claims.merchantId !== required.merchantId
  ) {
    throw new ForbiddenException('Token is not authorized for this merchant');
  }
  if (
    required.countryId !== undefined &&
    claims.countryId !== null &&
    claims.countryId !== required.countryId
  ) {
    throw new ForbiddenException('Token is not authorized for this country');
  }
}

@Injectable()
export class PortalAdminAuthGuard implements CanActivate {
  // Loaded once at guard-construction time (Nest providers are singletons by default), same
  // eager-throw-on-missing-secret precedent `ProgressApiAuthGuard` already sets.
  private readonly secret = loadPortalAdminAuthSecret();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithPortalAdmin>();
    const claims = this.authenticate(request);

    const requiredRoles = this.reflector.getAllAndOverride<readonly PortalAdminRole[] | undefined>(
      REQUIRE_PORTAL_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    // Fail closed: a route with no `@RequirePortalRoles(...)` at all is denied, mirroring the
    // portal's own `isRouteUnguarded` precedent (`route-authorisation.ts`) — an endpoint that
    // forgets the decorator ships closed, not open.
    if (requiredRoles === undefined || requiredRoles.length === 0) {
      throw new ForbiddenException('Route declares no authorized roles');
    }
    if (!requiredRoles.includes(claims.role)) {
      throw new ForbiddenException('Token role is not authorized for this route');
    }

    // The single point at which a verified scope enters the request — mirrors the portal's own
    // `JwtAuthGuard` comment: "the only writer of `authUser` that exists".
    request.portalAdmin = {
      role: claims.role,
      countryId: claims.countryId,
      tenantId: claims.tenantId,
      merchantId: claims.merchantId,
    };
    return true;
  }

  private authenticate(request: Request): PortalAdminTokenClaims {
    const header = request.headers.authorization;
    if (!header || Array.isArray(header) || !header.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice(BEARER_PREFIX.length).trim();
    if (token.length === 0) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      return verifyPortalAdminToken(token, this.secret);
    } catch (error) {
      if (error instanceof InvalidPortalAdminTokenError) {
        throw new UnauthorizedException('Invalid or expired token');
      }
      throw error;
    }
  }
}
