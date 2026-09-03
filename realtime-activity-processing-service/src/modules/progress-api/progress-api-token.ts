/**
 * T-RAP-040. Auth for this module's own HTTP surface (Implementation note 4: "customer- or
 * channel-facing (unlike the internal gRPC/Kafka paths) ... follow whatever external-facing auth
 * convention this repo already establishes for customer-scoped reads (check the portal's own
 * precedent before inventing one)").
 *
 * **Neither existing convention in this repo actually transfers here** — checked both before
 * writing this file:
 *  - The portal's own `JwtAuthGuard` (`portal/back-end/src/modules/auth/guards/jwt-auth.guard.ts`)
 *    is a `__Host-` cookie + browser session for an authenticated **admin/Maker**, not a customer —
 *    that file's own header is explicit that a machine-to-machine caller "gets its own credential
 *    type and its own guard ... not a second door into this one".
 *  - This service's own internal convention (`src/grpc/mtls.guard.ts`) authenticates a **service**
 *    identity via a client certificate, not a **customer** — there is no per-customer certificate
 *    to check here, and reusing the service-identity allowlist for a customer-facing read would
 *    conflate two different trust domains.
 *
 * So this is a **new, narrow credential type**, scoped to exactly this HTTP surface — a signed
 * bearer token asserting *"the bearer is authorized to read this one customerId's progress, in
 * this one tenant"*, minted by whatever upstream channel/gateway already knows the customer's real
 * identity (out of this service's own concern, same as `activityEventId`'s own upstream-trusted
 * shape). Deliberately not a full JWT library dependency (`package.json` is outside this task's
 * file scope, and this repo already has a zero-dependency, `node:crypto`-only precedent for
 * exactly this shape — `encryption.service.ts`'s own HMAC-SHA-256 `hash()`): a minimal
 * `payload.signature` HMAC token is sufficient for the one property this guard needs to check.
 *
 * Flagged for the architect/reviewer in this task's own completion report as a genuinely new
 * decision, not a reuse of an established one (`AGENT-PROTOCOL.md` §7's "if the task description
 * conflicts with a design doc" spirit extended to "no design doc actually specifies this").
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ProgressApiTokenClaims {
  tenantId: number;
  /** The one `customerId` this token authorizes — checked verbatim (not hashed) against the
   * request's own `:customerId` path parameter by the guard (R4 note: this is the same plaintext
   * value the caller itself supplied on the URL, never persisted or logged by this service). */
  customerId: string;
  /** Unix seconds. Required — an unexpiring bearer credential for a customer-facing surface is a
   * standing liability this module never accepts. */
  exp: number;
}

export class InvalidProgressApiTokenError extends Error {}

const MIN_SECRET_BYTES = 32;

/**
 * `PROGRESS_API_AUTH_SECRET` (base64-encoded, >= 32 bytes) — read directly from `process.env`, not
 * `ConfigService`/`src/config/config.schema.ts`: that shared schema is `agent-rap-foundation`'s
 * file scope (`src/config/**`), not this task's — same "the shared config schema is out of this
 * file-scope owner's reach" precedent `campaign-config.client.ts`'s
 * `loadCampaignConfigClientOptions()` and `encryption.service.ts`'s `loadEncryptionKeyMaterial()`
 * already documented. Throws synchronously (never a default, never logged — R8) so a missing/
 * invalid secret fails this module's own provider construction rather than silently accepting
 * every token.
 */
export function loadProgressApiAuthSecret(): Buffer {
  const raw = process.env.PROGRESS_API_AUTH_SECRET?.trim();
  if (!raw) {
    throw new Error(
      'PROGRESS_API_AUTH_SECRET is required (base64-encoded, >= 32 bytes) — no default, no ' +
        'fallback (AGENT-PROTOCOL.md R8)',
    );
  }
  const secret = Buffer.from(raw, 'base64');
  if (secret.length < MIN_SECRET_BYTES) {
    throw new Error(
      `PROGRESS_API_AUTH_SECRET must decode to at least ${MIN_SECRET_BYTES} bytes ` +
        `(got ${secret.length})`,
    );
  }
  return secret;
}

function isPlainClaims(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseClaims(value: unknown): ProgressApiTokenClaims {
  if (
    !isPlainClaims(value) ||
    typeof value.tenantId !== 'number' ||
    typeof value.customerId !== 'string' ||
    value.customerId.length === 0 ||
    typeof value.exp !== 'number'
  ) {
    throw new InvalidProgressApiTokenError('Malformed token claims');
  }
  return { tenantId: value.tenantId, customerId: value.customerId, exp: value.exp };
}

function hmac(payloadSegment: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(payloadSegment).digest('base64url');
}

/** Issuance is not this service's own concern in production (the upstream channel/gateway mints
 * these) — exported purely so tests (and any future local-issuer tooling) don't hand-roll the
 * wire format a second time. */
export function signProgressApiToken(claims: ProgressApiTokenClaims, secret: Buffer): string {
  const payloadSegment = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payloadSegment}.${hmac(payloadSegment, secret)}`;
}

/**
 * Verifies the HMAC (constant-time comparison — no early-exit timing side channel on the
 * signature check) and the expiry, in that order. Throws `InvalidProgressApiTokenError` for every
 * failure mode (malformed shape, bad signature, expired) — the guard maps every one of those to
 * the same `401`, never distinguishing which in the response body (same "don't tell the client
 * why" reasoning `portal/back-end`'s own `SessionInvalidHttpException` already applies).
 */
export function verifyProgressApiToken(
  token: string,
  secret: Buffer,
  now: Date = new Date(),
): ProgressApiTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw new InvalidProgressApiTokenError('Malformed token');
  }
  const [payloadSegment, signature] = parts;

  const expectedSignature = hmac(payloadSegment, secret);
  const provided = Buffer.from(signature, 'base64url');
  const expected = Buffer.from(expectedSignature, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new InvalidProgressApiTokenError('Signature mismatch');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidProgressApiTokenError('Malformed token payload');
  }
  const claims = parseClaims(parsed);

  if (claims.exp * 1000 <= now.getTime()) {
    throw new InvalidProgressApiTokenError('Token expired');
  }
  return claims;
}
