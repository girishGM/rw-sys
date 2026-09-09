/**
 * T-RTS-032 — customer-identity guard for T-RTS-030's customer-facing endpoints
 * (`GET /customers/{customerId}/rewards/...`, `brain-storm/04-API-DESIGN.md` §1).
 *
 * ### A different trust domain from the portal admin guard
 *
 * A customer is not a portal user at all — there is no `portal_users` row, no
 * `super_admin`/`tenant_admin`/... role, nothing in `TokenService.AccessTokenClaims` describes a
 * customer. So unlike `portal-admin-auth.guard.ts` (which had a real, if structurally unusable,
 * candidate to investigate — the portal's own JWT), this guard was never a candidate for reusing
 * the portal's `JwtAuthGuard` in the first place; implementation note 2 ("two guards, two trust
 * levels ... do not build one guard that tries to serve both") is satisfied by construction, not
 * by choice.
 *
 * This mirrors, almost exactly, a precedent already shipped in this exact repo family for the
 * identical shape of problem: `realtime-activity-processing-service`'s own customer-facing HTTP
 * surface (`ProgressApiAuthGuard`/`progress-api-token.ts`). That task's own header independently
 * investigated reusing the portal's cookie-based session JWT for a customer-facing read and
 * rejected it for the same reasons `portal-admin-auth.guard.ts`'s header lays out here (cookie is
 * browser-scoped to the portal's own origin, and the portal's own guard explicitly reserves a
 * "second door" for exactly this shape of caller) — then built a bespoke, `node:crypto`-only HMAC
 * bearer token, scoped to exactly one `customerId` within one `tenantId`. This guard reuses that
 * same wire format (a two-segment `payload.signature` base64url token) for consistency across the
 * service family, adapted to this service's own claim shape.
 *
 * **Issuance is out of this service's own concern**, same "out of this service's own concern"
 * boundary `progress-api-token.ts` documents for its own token: whatever upstream channel/gateway
 * already knows the customer's real identity (an OTP flow, a carrier's own session, a mobile app's
 * login) mints this token; this service only verifies it. `signCustomerToken` is exported purely
 * so tests don't hand-roll the wire format a second time.
 *
 * **R6 discipline**: the plaintext `customerId` this guard extracts is read only from the verified
 * token and compared only against the request's own `:customerId` path parameter — the same
 * plaintext value the caller supplied on the URL. It is never logged by this guard (errors here
 * carry no claim data — see `authenticate`'s catch branch) and never persisted; hashing for
 * `customer_id_hash` lookups happens downstream, in the repository layer T-RTS-030 owns.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/** The wire claims this guard verifies. `exp` is Unix seconds. */
export interface CustomerTokenClaims {
  readonly tenantId: number;
  readonly customerId: string;
  readonly exp: number;
}

/** What lands on `request.customerAuth` once verified — the claims minus the expiry. */
export type CustomerAuthContext = Omit<CustomerTokenClaims, 'exp'>;

export interface RequestWithCustomerAuth extends Request {
  customerAuth: CustomerAuthContext;
}

export class InvalidCustomerTokenError extends Error {}

const BEARER_PREFIX = 'Bearer ';
const MIN_SECRET_BYTES = 32;
const ENV_VAR = 'CUSTOMER_API_AUTH_SECRET';

/**
 * Read directly from `process.env`, not `ConfigService`/`src/config/config.schema.ts` — that
 * shared bootstrap schema is T-RTS-001's own file scope, not this task's (see that file's own
 * header). Throws synchronously at guard-construction time (fail fast, R11/R12) so a missing
 * secret fails boot, not the first real request.
 */
export function loadCustomerAuthSecret(): Buffer {
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

function parseClaims(value: unknown): CustomerTokenClaims {
  if (
    !isPlainObject(value) ||
    typeof value.tenantId !== 'number' ||
    typeof value.customerId !== 'string' ||
    value.customerId.length === 0 ||
    typeof value.exp !== 'number'
  ) {
    throw new InvalidCustomerTokenError('Malformed token claims');
  }
  return { tenantId: value.tenantId, customerId: value.customerId, exp: value.exp };
}

function hmac(payloadSegment: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(payloadSegment).digest('base64url');
}

/** Issuance is not this service's own concern in production (see this file's header) — exported
 * purely so tests (and any future local-issuer tooling) don't hand-roll the wire format twice. */
export function signCustomerToken(claims: CustomerTokenClaims, secret: Buffer): string {
  const payloadSegment = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payloadSegment}.${hmac(payloadSegment, secret)}`;
}

/**
 * Verifies the HMAC (constant-time comparison) and the expiry, in that order, then the claim
 * shape. Throws {@link InvalidCustomerTokenError} for every failure mode — the guard maps all of
 * them to the same generic `401`, never distinguishing which in the response body.
 */
export function verifyCustomerToken(
  token: string,
  secret: Buffer,
  now: Date = new Date(),
): CustomerTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw new InvalidCustomerTokenError('Malformed token');
  }
  const [payloadSegment, signature] = parts;

  const expectedSignature = hmac(payloadSegment, secret);
  const provided = Buffer.from(signature, 'base64url');
  const expected = Buffer.from(expectedSignature, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new InvalidCustomerTokenError('Signature mismatch');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCustomerTokenError('Malformed token payload');
  }
  const claims = parseClaims(parsed);

  if (claims.exp * 1000 <= now.getTime()) {
    throw new InvalidCustomerTokenError('Token expired');
  }
  return claims;
}

@Injectable()
export class CustomerAuthGuard implements CanActivate {
  // Loaded once at guard-construction time (Nest providers are singletons by default) — same
  // eager-throw-on-missing-secret precedent `PortalAdminAuthGuard`/`ProgressApiAuthGuard` set.
  private readonly secret = loadCustomerAuthSecret();

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithCustomerAuth>();
    const claims = this.authenticate(request);

    // Cross-customer access attempt: a structurally valid token for a *different* customerId
    // than the one in the URL. Deliberately a distinct status from "no/invalid token" (`403`
    // vs `401`) — "I know who you are, and you may not read this row" is a different fact than
    // "who are you", mirroring `ProgressApiAuthGuard`'s own precedent exactly.
    const requestedCustomerId = request.params?.customerId;
    if (requestedCustomerId !== undefined && claims.customerId !== requestedCustomerId) {
      throw new ForbiddenException('Token is not authorized for this customerId');
    }

    request.customerAuth = { tenantId: claims.tenantId, customerId: claims.customerId };
    return true;
  }

  private authenticate(request: Request): CustomerTokenClaims {
    const header = request.headers.authorization;
    if (!header || Array.isArray(header) || !header.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice(BEARER_PREFIX.length).trim();
    if (token.length === 0) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      return verifyCustomerToken(token, this.secret);
    } catch (error) {
      if (error instanceof InvalidCustomerTokenError) {
        throw new UnauthorizedException('Invalid or expired token');
      }
      throw error;
    }
  }
}
