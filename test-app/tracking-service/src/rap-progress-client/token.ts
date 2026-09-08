/**
 * T-INT-021 — mints the exact bearer-token wire format RAP's own `progress-api-token.ts`
 * (`verifyProgressApiToken`) verifies, for both of its transports (`ProgressApiAuthGuard` over
 * REST, `ProgressQueryController.authenticate` over gRPC metadata): a two-segment
 * `payload.signature` base64url token, HMAC-SHA256 over the payload segment, payload
 * `{ tenantId, customerId, exp }`.
 *
 * Hand-written, dependency-free copy of RAP's own wire format — same reasoning
 * `reward-tracking-client/token.ts`'s own header gives for its own copy of reward-tracking-service's
 * `signCustomerToken`: this workspace has no dependency on RAP's own code, and issuance is
 * explicitly out of RAP's own concern (`progress-api-token.ts`'s header: "minted by whatever
 * upstream channel/gateway already knows the customer's real identity"). This app *is* that
 * upstream gateway for every one of its fixed demo customers, exactly as already established for
 * the identical problem in `reward-tracking-client/token.ts`.
 */
import { createHmac } from 'node:crypto';

export interface ProgressApiTokenClaims {
  readonly tenantId: number;
  readonly customerId: string;
  /** Unix seconds. */
  readonly exp: number;
}

function hmac(payloadSegment: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(payloadSegment).digest('base64url');
}

export function signProgressApiToken(claims: ProgressApiTokenClaims, secret: Buffer): string {
  const payloadSegment = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payloadSegment}.${hmac(payloadSegment, secret)}`;
}

/** Parses `PROGRESS_API_AUTH_SECRET`'s own base64 encoding (matching RAP's own
 * `loadProgressApiAuthSecret`'s expected wire format exactly — base64, >= 32 bytes) into the raw
 * key bytes `signProgressApiToken` needs. Returns `null` on anything that isn't usable — callers
 * treat that the same as "not configured", never throwing at import/construction time (this is a
 * consumer's optional-integration client, not RAP's own fail-boot-loudly guard). */
export function parseProgressApiAuthSecret(raw: string | undefined): Buffer | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  let secret: Buffer;
  try {
    secret = Buffer.from(trimmed, 'base64');
  } catch {
    return null;
  }
  const MIN_SECRET_BYTES = 32;
  return secret.length >= MIN_SECRET_BYTES ? secret : null;
}
