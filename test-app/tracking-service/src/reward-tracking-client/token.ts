/**
 * T-INT-022 — mints the exact bearer-token wire format `reward-tracking-service`'s own
 * `CustomerAuthGuard` verifies (`reward-tracking-service/src/modules/auth/customer-auth.guard.ts`:
 * a two-segment `payload.signature` base64url token, HMAC-SHA256 over the payload segment).
 *
 * **Issuance is explicitly out of RTS's own concern** (that guard's own header comment): "whatever
 * upstream channel/gateway already knows the customer's real identity ... mints this token; this
 * service only verifies it." This app *is* that upstream gateway for every one of its 3 fixed demo
 * customers (`data/customers.ts` — there is no real login/OTP flow here, same "invented identity"
 * status every other piece of this app's own customer model already has). Minting locally, from a
 * secret shared with RTS's own `CUSTOMER_API_AUTH_SECRET`, is therefore the correct place for this
 * to live — not a shortcut around a missing endpoint. Deliberately a hand-written, dependency-free
 * copy of RTS's own `signCustomerToken`/wire format (same reasoning `rap-client/client.ts`'s header
 * gives for its own local proto copy: this workspace has no dependency on that service's own code).
 */
import { createHmac } from 'node:crypto';

export interface CustomerTokenClaims {
  readonly tenantId: number;
  readonly customerId: string;
  /** Unix seconds. */
  readonly exp: number;
}

function hmac(payloadSegment: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(payloadSegment).digest('base64url');
}

export function signCustomerToken(claims: CustomerTokenClaims, secret: Buffer): string {
  const payloadSegment = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payloadSegment}.${hmac(payloadSegment, secret)}`;
}

/** Parses `CUSTOMER_API_AUTH_SECRET`'s own base64 encoding (matching RTS's own
 * `loadCustomerAuthSecret`'s expected wire format exactly) into the raw key bytes this module's
 * `signCustomerToken` needs. Returns `null` on anything that isn't usable — callers treat that the
 * same as "not configured", never throwing at import/construction time (this is a consumer's
 * optional-integration client, not RTS's own fail-boot-loudly guard). */
export function parseCustomerAuthSecret(raw: string | undefined): Buffer | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  let secret: Buffer;
  try {
    secret = Buffer.from(trimmed, 'base64');
  } catch {
    return null;
  }
  return secret.length > 0 ? secret : null;
}
