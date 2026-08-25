/**
 * T-018 — the wire vocabulary of payload encryption (07-DATA-PROTECTION.md §5).
 *
 * Everything in this file is a *name* the browser and the server must agree on exactly. It is
 * separated from the logic so that `front-end/src/lib/transportCrypto.ts` can be reviewed
 * side-by-side against one short list rather than against three services — a header spelt
 * differently on the two sides fails as "encryption silently never happens", which is the one
 * failure mode of this task that nothing else would catch.
 */

/**
 * Envelope format version. It appears in the `X-Payload-Encrypted` header and inside the AAD, so
 * a v1 payload can never be replayed against a future v2 reader with different framing.
 *
 * Deliberately the same literal as `CIPHERTEXT_VERSION` in `@/common/crypto/ciphertext.ts` but
 * **not** imported from it: the at-rest envelope and the transport envelope are different formats
 * with different lifetimes, and coupling their version numbers would mean bumping one forces a
 * re-encryption of the other.
 */
export const TRANSPORT_ENVELOPE_VERSION = 'v1';

/**
 * Set by the client on an encrypted request, and by the server on an encrypted response.
 *
 * The task file fixes both the name and the value (`X-Payload-Encrypted: v1`). Its **presence**
 * is what drives request decryption — see `payload-decrypt.interceptor.ts` for why the header,
 * not the configured mode, is the trigger in that direction.
 */
export const PAYLOAD_ENCRYPTED_HEADER = 'x-payload-encrypted';

/**
 * The client's ECDH P-256 public key on `POST /auth/login`, and the server's on the response.
 * Base64 of the uncompressed SEC1 point (`0x04 || X || Y`, 65 bytes) — the format both
 * `crypto.createECDH()` and WebCrypto's `exportKey('raw', …)` produce natively, so neither side
 * needs an ASN.1 parser.
 */
export const TRANSPORT_PUBLIC_KEY_HEADER = 'x-transport-public-key';

/**
 * The `kid` the client must put in every envelope, returned on the login response beside the
 * server's public key.
 *
 * The browser cannot derive it: `kid` is `sess_<session uuid>` and the session id lives inside
 * the httpOnly access token, which script cannot read. Telling the client its own session id
 * discloses nothing new — `GET /auth/sessions` already returns it, flagged `current: true`
 * (03-API-CONTRACT.md §2) — and it is not a credential on its own: possession of the session id
 * without the `__Host-rs_at` cookie buys nothing.
 */
export const TRANSPORT_KID_HEADER = 'x-transport-kid';

/**
 * The server's answer to "what should I encrypt?", returned on the login response as compact
 * JSON — see {@link TransportPolicyAdvertisement}.
 *
 * A header rather than a body field so that `LoginResponseDto` is untouched and T-011 TC-5 ("the
 * login body contains no token of any kind") keeps asserting exactly what it asserted before.
 */
export const TRANSPORT_POLICY_HEADER = 'x-payload-encryption';

/**
 * What the client is told at handshake time. Nothing here is secret: `mode` and `routeOverrides`
 * come from the committed `config/data-protection.json`, and `fields` is a list of *field names*
 * already visible in the API contract — never values, never key material.
 */
export interface TransportPolicyAdvertisement {
  readonly mode: string;
  /** Keyed `"<METHOD> <path>"`, normalised by `normaliseRouteOverrideKey` (T-017). */
  readonly routeOverrides: Readonly<Record<string, string>>;
  /**
   * Field names whose policy says `in_transit = 'payload_encrypt'`. Used by the client in
   * `fields` mode to decide what to encrypt in a request body; the server needs no such list
   * because it resolves each field it actually sees against the policy cache directly.
   */
  readonly fields: readonly string[];
}

/**
 * The `kid` of a transport envelope is `sess_<session uuid>`, per 07-DATA-PROTECTION.md §5's
 * example (`"kid": "sess_9f2a"`).
 *
 * It is an **assertion**, not a lookup key. The session whose key is used is always the one in
 * the verified JWT (R3); this value is compared against it and a mismatch is a 401. See
 * `payload-decrypt.interceptor.ts`.
 */
export const SESSION_KID_PREFIX = 'sess_';

/** Builds the `kid` for a session. The only place the prefix is concatenated. */
export function sessionKid(sessionId: string): string {
  return `${SESSION_KID_PREFIX}${sessionId}`;
}

/**
 * Routes that are **always** cleartext, per the task file's implementation note 5 and
 * 07-DATA-PROTECTION.md §5: the session key does not exist yet on any of them, and bootstrapping
 * encryption from nothing is circular.
 *
 * Matched against the path with the global `api/v1` prefix stripped (see `normalisePath`), so
 * this list reads the way the design document writes it. `/health` is a **prefix** match — the
 * task file writes `/health*`, and a liveness probe on `/health/ready` must not become
 * undecodable to a load balancer that has no session at all.
 */
export const ALWAYS_CLEARTEXT_EXACT: readonly string[] = Object.freeze([
  '/auth/login',
  '/auth/refresh',
  '/auth/forgot-password',
  '/auth/reset-password',
]);

/** @see ALWAYS_CLEARTEXT_EXACT */
export const ALWAYS_CLEARTEXT_PREFIXES: readonly string[] = Object.freeze(['/health']);

/** The global prefix `main.ts` sets. Stripped before matching, so the lists above stay readable. */
export const GLOBAL_PREFIX = '/api/v1';

/**
 * `/api/v1/Auth/Login/` → `/auth/login`.
 *
 * Query strings never reach `request.path`, but a trailing slash and mixed case both do, and both
 * would otherwise slip past an exact-match list. Lower-casing is safe here because every route in
 * this application is lower-case; it is *not* applied to anything that reaches a database.
 */
export function normalisePath(path: string): string {
  let normalised = path.toLowerCase();
  if (normalised === GLOBAL_PREFIX) normalised = '/';
  else if (normalised.startsWith(`${GLOBAL_PREFIX}/`)) {
    normalised = normalised.slice(GLOBAL_PREFIX.length);
  }
  while (normalised.length > 1 && normalised.endsWith('/')) {
    normalised = normalised.slice(0, -1);
  }
  return normalised;
}

/** Whether this path may never carry an encrypted payload in either direction. */
export function isAlwaysCleartext(path: string): boolean {
  const normalised = normalisePath(path);
  if (ALWAYS_CLEARTEXT_EXACT.includes(normalised)) return true;
  return ALWAYS_CLEARTEXT_PREFIXES.some(
    (prefix) => normalised === prefix || normalised.startsWith(`${prefix}/`),
  );
}

/**
 * The `system_messages` keys this task introduces.
 *
 * `PAYLOAD_DECRYPT_FAILED` is the only one a client ever sees, and it carries **no detail** —
 * task file implementation note 8. Whether the ciphertext was truncated, the tag was wrong, the
 * base64 was invalid or the JSON inside did not parse is a distinction that only helps somebody
 * probing the format; the server log keeps the reason.
 */
export const TRANSPORT_ERROR_CODE = Object.freeze({
  /** 400. A payload arrived that this server could not open. */
  PAYLOAD_DECRYPT_FAILED: 'PAYLOAD_DECRYPT_FAILED',
});
