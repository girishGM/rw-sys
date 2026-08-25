/**
 * T-047 — the first of the three checks every internal call passes, in order:
 *
 *   1. **this file** — is there a client certificate this portal trusts, and is the caller trying
 *      to use a *portal* credential here?
 *   2. `service-scope.guard.ts` — does that identity hold a grant covering the tenant asked for?
 *   3. `section-grant.guard.ts` — and does it cover the sections asked for?
 *
 * ### What the TLS layer has already done before this runs
 *
 * `InternalTlsListener` sets `requestCert: true` and `rejectUnauthorized: true`, so a connection
 * presenting **no** certificate (TC-9) or one **not signed by the configured CA** never completes
 * its handshake and no request reaches this file. The checks here are the second layer: a
 * certificate can be validly signed and still not be an identity this portal has ever heard of
 * (TC-10), and `socket.authorized` is re-read rather than assumed, because a future change to the
 * listener options must not silently downgrade the guarantee.
 *
 * ### Portal credentials are refused, not ignored
 *
 * 09-INTEGRATION.md §7: *"Portal cookies and JWTs are rejected outright on this port. It is a
 * different trust domain and must not share credentials with the browser surface."* Ignoring them
 * would be enough for correctness — nothing here reads a cookie — but not enough for operations: a
 * session cookie arriving on port 50051 means a browser, a proxy or a service is misconfigured,
 * and the failure that surfaces it should be immediate and loud rather than a puzzle six months
 * later. TC-12 and TC-41 are the same rule on the two halves of this listener.
 */
import type { PeerIdentity } from './wire/grpc-http2.server';
import { MutualTlsRequiredError, PortalCredentialRejectedError } from './grpc.errors';

/**
 * Headers that carry a portal session and therefore may not appear here.
 *
 * `cookie` covers the access/refresh/CSRF cookies (`session.constants.ts`); `authorization` covers
 * a bearer token; `x-csrf-token` is browser-surface-only by construction. gRPC metadata for this
 * service is empty by design — the certificate *is* the credential.
 */
export const REJECTED_PORTAL_HEADERS: readonly string[] = Object.freeze([
  'cookie',
  'authorization',
  'x-csrf-token',
]);

/** SAN prefixes that name a service. `IP:` deliberately does not: an address is a location, not
 * an identity, and grants written against one break the moment a pod moves. */
const IDENTITY_SAN_PREFIXES: readonly string[] = Object.freeze(['DNS:', 'URI:']);

/**
 * Every identity this certificate could be known by, most specific first.
 *
 * The SAN values with their `DNS:`/`URI:` type prefix stripped, in certificate order, then the
 * subject CN. A grant is written against one of these strings, so an operator writes
 * `txn-runtime.internal`, not `DNS:txn-runtime.internal` — the prefix is a certificate encoding
 * detail and putting it in an access-control table would be inviting a mismatch nobody can see.
 *
 * The CN is last and is a fallback for certificates issued before SANs were mandatory. It is
 * included rather than dropped because refusing an otherwise-valid, CA-signed certificate for
 * lacking a SAN would take the runtime down at exactly the wrong moment; it is *last* because a
 * SAN is the modern, unambiguous field.
 */
export function serviceIdentityCandidates(peer: PeerIdentity): readonly string[] {
  const candidates: string[] = [];
  for (const entry of peer.subjectAltNames) {
    const prefix = IDENTITY_SAN_PREFIXES.find((candidate) => entry.startsWith(candidate));
    if (prefix === undefined) continue;
    const value = entry.slice(prefix.length).trim();
    if (value !== '' && !candidates.includes(value)) candidates.push(value);
  }
  if (peer.commonName !== null && peer.commonName !== '' && !candidates.includes(peer.commonName)) {
    candidates.push(peer.commonName);
  }
  return candidates;
}

/**
 * Refuses a call that presented no usable client certificate.
 *
 * Returns the candidate identities so the caller does not re-derive them; whether any of them is
 * *known* is `service-scope.guard.ts`'s question, not this one's.
 */
export function assertMutualTls(peer: PeerIdentity): readonly string[] {
  if (!peer.hasCertificate) {
    throw new MutualTlsRequiredError('no client certificate was presented');
  }
  if (!peer.authorized) {
    throw new MutualTlsRequiredError(
      peer.authorizationError ?? 'the client certificate did not validate against the trusted CA',
    );
  }
  const candidates = serviceIdentityCandidates(peer);
  if (candidates.length === 0) {
    throw new MutualTlsRequiredError('the client certificate carries no DNS/URI SAN and no CN');
  }
  return candidates;
}

/** Refuses a call carrying a browser-surface credential (TC-12, TC-41). */
export function assertNoPortalCredentials(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): void {
  for (const header of REJECTED_PORTAL_HEADERS) {
    const value = headers[header];
    if (value === undefined) continue;
    if (Array.isArray(value) ? value.length === 0 : String(value).trim() === '') continue;
    throw new PortalCredentialRejectedError(header);
  }
}
