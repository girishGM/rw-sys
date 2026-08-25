/**
 * T-018 — the browser side of payload encryption (07-DATA-PROTECTION.md §5).
 *
 * The API T-022's HTTP client uses. Four things happen here and nowhere else in the SPA:
 * the handshake on login, the decision about what to encrypt, sealing a request body, and
 * opening a response body.
 *
 * ============================================================================================
 * ## What this protects against — and what it does not
 *
 * Payload encryption on top of TLS buys protection from **TLS-terminating intermediaries**
 * (load balancers, WAFs, corporate proxies), keeps payloads opaque in **logs, APM traces and
 * crash dumps** at every hop, and satisfies compliance mandates that require encryption
 * independent of transport.
 *
 * **It does not protect against XSS.** A script running in this page can call
 * {@link encryptRequestBody} with the same non-extractable `CryptoKey` the application uses and
 * get the same answer. Non-extractability stops the key being *stolen and used elsewhere*, not
 * being *used in place*. The controls against XSS are the strict CSP and the httpOnly cookies in
 * 02-SECURITY.md.
 * ============================================================================================
 *
 * ## Where the key lives (AGENT-PROTOCOL R5, TC-23)
 *
 * In a module-scoped variable, as a `CryptoKey` handle. **Never** in `localStorage`,
 * `sessionStorage`, a cookie, `window`, a React context, or anywhere else script can read bytes
 * from. `exportKey` on it throws. Because it is module state and not persisted, a page reload
 * ends the transport session — the SPA re-handshakes on its next login, and until then talks
 * cleartext over TLS, which is exactly what `mode: "off"` does and is safe by construction.
 *
 * ## The failure contract: surface, never retry (TC-22)
 *
 * Every failure in here throws {@link TransportCryptoError} and none of them retries. A client
 * that retried a payload the server could not open would turn one broken request into a loop,
 * and the two causes it could have — a broken payload (400) or a dead session (401) — are both
 * things a retry cannot fix. T-022's client handles the 401 the way it handles every other 401.
 *
 * ## The correlation id is not optional
 *
 * It is authenticated data: it binds one envelope to one request (TC-13). The caller must pass
 * the same value it puts in the `X-Correlation-Id` request header, and must use the id the server
 * echoes back in that header when opening a response. Get it wrong and the tag check fails, which
 * is the intended behaviour, not a bug to work around.
 */
import {
  decryptWithKey,
  deriveTransportKey,
  encryptWithKey,
  fromBase64,
  generateEcdhKeyPair,
  toBase64,
} from './webcrypto-keys';

/** Must match `TRANSPORT_ENVELOPE_VERSION` on the server. */
export const TRANSPORT_ENVELOPE_VERSION = 'v1';

/** Header names, matching `back-end/src/common/transport-crypto/transport-crypto.constants.ts`. */
export const PAYLOAD_ENCRYPTED_HEADER = 'X-Payload-Encrypted';
export const TRANSPORT_PUBLIC_KEY_HEADER = 'X-Transport-Public-Key';
export const TRANSPORT_KID_HEADER = 'X-Transport-Kid';
export const TRANSPORT_POLICY_HEADER = 'X-Payload-Encryption';
export const CORRELATION_HEADER = 'X-Correlation-Id';

/** The three levels of 07-DATA-PROTECTION.md §5. */
export type TransportMode = 'off' | 'fields' | 'full';

/** The `{ kid, iv, tag, ct }` envelope, exactly as the server writes and reads it. */
export interface PayloadEnvelope {
  readonly kid: string;
  readonly iv: string;
  readonly tag: string;
  readonly ct: string;
}

/** What the server advertises on the login response, in the `X-Payload-Encryption` header. */
export interface TransportPolicy {
  readonly mode: TransportMode;
  readonly routeOverrides: Readonly<Record<string, TransportMode>>;
  /** Field names to encrypt in `fields` mode. The browser holds no policy table of its own. */
  readonly fields: readonly string[];
}

/** Every failure this module raises. Never retried by the caller — see the header. */
export class TransportCryptoError extends Error {
  constructor(
    message: string,
    readonly reason: 'not_established' | 'unusable_response' | 'decrypt_failed' | 'encrypt_failed',
  ) {
    super(message);
    this.name = 'TransportCryptoError';
  }
}

interface TransportSession {
  readonly key: CryptoKey;
  readonly kid: string;
  readonly policy: TransportPolicy;
}

/** Everything the caller must hold between `beginHandshake` and `completeHandshake`. */
export interface PendingHandshake {
  readonly privateKey: CryptoKey;
  readonly publicKeyBase64: string;
}

/**
 * The live transport session. Module state, deliberately: it must not be reachable from the
 * React tree, from a store that persists, or from anything a devtools panel serialises.
 */
let session: TransportSession | null = null;

/**
 * The `Crypto` implementation. Injectable so a test can supply Node's `webcrypto` — jsdom
 * provides `getRandomValues` but no `subtle`, so without this seam none of this file could be
 * unit-tested at all, and untested crypto is the thing AGENT-PROTOCOL §7 is about.
 */
let cryptoImpl: Crypto | null = null;

/** Overrides the `Crypto` used. Pass `null` to fall back to the platform's own. */
export function configureTransportCrypto(implementation: Crypto | null): void {
  cryptoImpl = implementation;
}

function requireCrypto(): Crypto {
  const implementation = cryptoImpl ?? globalThis.crypto;
  if (implementation?.subtle === undefined) {
    throw new TransportCryptoError(
      'WebCrypto is unavailable. Payload encryption requires a secure context (HTTPS or ' +
        'localhost); the portal will fall back to TLS alone.',
      'not_established',
    );
  }
  return implementation;
}

// --- handshake -----------------------------------------------------------------------------

/**
 * Step 1 of the login handshake: generate the ephemeral keypair.
 *
 * Called **before** the login request, because the public key travels on it. The private key is
 * handed back to the caller rather than stashed in module state so that two concurrent login
 * attempts — a double-submitted form, a retried request — cannot have one overwrite the other's
 * key and derive a shared secret against the wrong point.
 */
export async function beginHandshake(): Promise<PendingHandshake> {
  const crypto = requireCrypto();
  return generateEcdhKeyPair(crypto.subtle);
}

/**
 * Step 2: derive the session key from the server's response headers.
 *
 * Returns `false` — rather than throwing — when the server did not complete the handshake (no
 * public key header). That is the documented degraded path: the portal continues on TLS alone,
 * exactly as `mode: "off"` does. Throwing would turn an optional defence-in-depth layer into a
 * login failure.
 */
export async function completeHandshake(
  pending: PendingHandshake,
  headers: TransportResponseHeaders,
): Promise<boolean> {
  const serverPublicKey = headers.get(TRANSPORT_PUBLIC_KEY_HEADER);
  const kid = headers.get(TRANSPORT_KID_HEADER);
  if (serverPublicKey === null || kid === null) {
    resetTransport();
    return false;
  }

  const crypto = requireCrypto();
  const key = await deriveTransportKey(
    crypto.subtle,
    pending.privateKey,
    pending.publicKeyBase64,
    serverPublicKey,
  );

  session = { key, kid, policy: parsePolicy(headers.get(TRANSPORT_POLICY_HEADER)) };
  return true;
}

/**
 * Drops the session key. Called on logout, on `logout-all`, and on any 401.
 *
 * There is nothing to wipe: the key is a `CryptoKey` handle whose bytes were never in JS memory,
 * so dropping the reference is the whole of the operation.
 */
export function resetTransport(): void {
  session = null;
}

/** Whether a transport key is currently held. */
export function isTransportEstablished(): boolean {
  return session !== null;
}

/**
 * The mode for one route, resolved exactly as `TransportPolicyService.modeFor` does on the
 * server: always-cleartext routes first, then a route override, then the global mode.
 *
 * The two implementations are asserted equivalent in `transportCrypto.spec.ts` — a client that
 * encrypts a route the server treats as cleartext produces a 400 on every request to it.
 */
export function transportModeFor(method: string, path: string): TransportMode {
  if (session === null) return 'off';
  if (isAlwaysCleartext(path)) return 'off';

  const key = `${method.toUpperCase()} ${normalisePath(path)}`;
  return session.policy.routeOverrides[key] ?? session.policy.mode;
}

// --- request -------------------------------------------------------------------------------

/** What {@link encryptRequestBody} hands back to the HTTP client. */
export interface EncryptedRequest {
  readonly body: unknown;
  /** `true` when the caller must add `X-Payload-Encrypted: v1` to the request. */
  readonly encrypted: boolean;
}

/**
 * Seals a request body according to the effective mode.
 *
 * `full` wraps the whole body in one envelope; `fields` replaces only the values whose names the
 * server advertised as `payload_encrypt`, leaving the rest readable — which is the entire point
 * of that mode (payloads stay debuggable, CPU cost stays low).
 *
 * `off`, no session, or a body that is not a JSON object/array returns the body untouched with
 * `encrypted: false`.
 */
export async function encryptRequestBody(
  method: string,
  path: string,
  body: unknown,
  correlationId: string,
): Promise<EncryptedRequest> {
  const live = session;
  const mode = transportModeFor(method, path);
  if (live === null || mode === 'off' || !isJsonContainer(body)) {
    return { body, encrypted: false };
  }

  try {
    if (mode === 'full') {
      const envelope = await seal(live, JSON.stringify(body), 'req', '$', correlationId);
      return { body: envelope, encrypted: true };
    }

    const flagged = new Set(live.policy.fields);
    const counter = { count: 0 };
    const sealed = await sealFields(live, body, '', 0, flagged, counter, correlationId);
    return { body: counter.count > 0 ? sealed : body, encrypted: counter.count > 0 };
  } catch (error) {
    throw new TransportCryptoError(
      `Could not encrypt the request payload (${describe(error)}).`,
      'encrypt_failed',
    );
  }
}

// --- response ------------------------------------------------------------------------------

/** The subset of `Headers`/axios headers this module reads. */
export interface TransportResponseHeaders {
  get(name: string): string | null;
}

/**
 * Opens a response body.
 *
 * Driven by the `X-Payload-Encrypted` response header, not by the configured mode, so a route
 * override the client does not know about still decodes. A response with no such header is
 * returned untouched — that is the cleartext path, and it is what every 204 and every error
 * response takes (exception filters run outside the server's encryption interceptor, deliberately,
 * so that a `PAYLOAD_DECRYPT_FAILED` is always readable).
 */
export async function decryptResponseBody(
  body: unknown,
  headers: TransportResponseHeaders,
): Promise<unknown> {
  if (headers.get(PAYLOAD_ENCRYPTED_HEADER) === null) return body;

  const live = session;
  if (live === null) {
    throw new TransportCryptoError(
      'The server sent an encrypted response but this client holds no transport key. Log in ' +
        'again to re-establish one.',
      'not_established',
    );
  }

  const correlationId = headers.get(CORRELATION_HEADER);
  if (correlationId === null) {
    throw new TransportCryptoError(
      `An encrypted response carried no ${CORRELATION_HEADER}; its payload cannot be ` +
        'authenticated.',
      'unusable_response',
    );
  }

  try {
    if (isPayloadEnvelope(body)) {
      return JSON.parse(await open(live, body, 'res', '$', correlationId)) as unknown;
    }
    if (!isJsonContainer(body)) return body;
    return await openFields(live, body, '', 0, correlationId);
  } catch (error) {
    if (error instanceof TransportCryptoError) throw error;
    throw new TransportCryptoError(
      `Could not decrypt the response payload (${describe(error)}). This is not retried — the ` +
        'same request would fail the same way.',
      'decrypt_failed',
    );
  }
}

// --- envelope ------------------------------------------------------------------------------

/** Whether a value has exactly the four envelope keys, all strings. Mirrors the server's test. */
export function isPayloadEnvelope(value: unknown): value is PayloadEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 4) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.kid === 'string' &&
    typeof candidate.iv === 'string' &&
    typeof candidate.tag === 'string' &&
    typeof candidate.ct === 'string'
  );
}

/**
 * The additional authenticated data: `version|kid|direction|correlationId|path`.
 *
 * **Must match `buildAad` in `back-end/src/common/transport-crypto/transport-envelope.ts`
 * exactly.** `transportCrypto.spec.ts` opens a Node-sealed envelope with this implementation and
 * vice versa, so a divergence is a failing test rather than a silent 400 in production.
 */
export function buildAad(
  kid: string,
  direction: 'req' | 'res',
  correlationId: string,
  path: string,
): Uint8Array {
  return new TextEncoder().encode(
    [TRANSPORT_ENVELOPE_VERSION, kid, direction, correlationId, path].join('|'),
  );
}

/**
 * The correlation id is threaded through every helper as an argument rather than held in module
 * state. Two requests can be in flight at once — the SPA fires several on a dashboard load — and
 * a shared mutable would let one overwrite the other's binding between two `await`s, producing
 * envelopes bound to the wrong request that fail on the server for no reproducible reason.
 */
async function seal(
  live: TransportSession,
  plaintext: string,
  direction: 'req' | 'res',
  path: string,
  correlationId: string,
): Promise<PayloadEnvelope> {
  const crypto = requireCrypto();
  const sealed = await encryptWithKey(
    crypto,
    live.key,
    new TextEncoder().encode(plaintext),
    buildAad(live.kid, direction, correlationId, path),
  );
  return {
    kid: live.kid,
    iv: toBase64(sealed.iv),
    tag: toBase64(sealed.tag),
    ct: toBase64(sealed.ct),
  };
}

async function open(
  live: TransportSession,
  envelope: PayloadEnvelope,
  direction: 'req' | 'res',
  path: string,
  correlationId: string,
): Promise<string> {
  const crypto = requireCrypto();
  const plaintext = await decryptWithKey(
    crypto.subtle,
    live.key,
    { iv: fromBase64(envelope.iv), tag: fromBase64(envelope.tag), ct: fromBase64(envelope.ct) },
    buildAad(live.kid, direction, correlationId, path),
  );
  return new TextDecoder().decode(plaintext);
}

/** Depth bound, matching `MAX_PAYLOAD_DEPTH` on the server. */
const MAX_DEPTH = 12;

async function sealFields(
  live: TransportSession,
  value: unknown,
  path: string,
  depth: number,
  flagged: ReadonlySet<string>,
  counter: { count: number },
  correlationId: string,
): Promise<unknown> {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return Promise.all(
      value.map((item, index) =>
        sealFields(
          live,
          item,
          joinPath(path, String(index)),
          depth + 1,
          flagged,
          counter,
          correlationId,
        ),
      ),
    );
  }

  const out: Record<string, unknown> = {};
  for (const [property, raw] of Object.entries(value as Record<string, unknown>)) {
    const childPath = joinPath(path, property);
    if (raw !== undefined && flagged.has(property)) {
      out[property] = await seal(live, JSON.stringify(raw), 'req', childPath, correlationId);
      counter.count += 1;
      continue;
    }
    out[property] = await sealFields(
      live,
      raw,
      childPath,
      depth + 1,
      flagged,
      counter,
      correlationId,
    );
  }
  return out;
}

async function openFields(
  live: TransportSession,
  value: unknown,
  path: string,
  depth: number,
  correlationId: string,
): Promise<unknown> {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;

  if (isPayloadEnvelope(value)) {
    return JSON.parse(await open(live, value, 'res', path, correlationId)) as unknown;
  }

  if (Array.isArray(value)) {
    return Promise.all(
      value.map((item, index) =>
        openFields(live, item, joinPath(path, String(index)), depth + 1, correlationId),
      ),
    );
  }

  const out: Record<string, unknown> = {};
  for (const [property, raw] of Object.entries(value as Record<string, unknown>)) {
    out[property] = await openFields(live, raw, joinPath(path, property), depth + 1, correlationId);
  }
  return out;
}

// --- route matching ------------------------------------------------------------------------

/** Mirrors `ALWAYS_CLEARTEXT_EXACT` on the server. */
const ALWAYS_CLEARTEXT_EXACT: readonly string[] = [
  '/auth/login',
  '/auth/refresh',
  '/auth/forgot-password',
  '/auth/reset-password',
];

/** Mirrors `ALWAYS_CLEARTEXT_PREFIXES`. */
const ALWAYS_CLEARTEXT_PREFIXES: readonly string[] = ['/health'];

const GLOBAL_PREFIX = '/api/v1';

/** Mirrors `normalisePath` on the server, including the query-string strip the browser needs. */
export function normalisePath(path: string): string {
  let normalised = path.split('?')[0].split('#')[0].toLowerCase();
  if (normalised === GLOBAL_PREFIX) normalised = '/';
  else if (normalised.startsWith(`${GLOBAL_PREFIX}/`)) {
    normalised = normalised.slice(GLOBAL_PREFIX.length);
  }
  while (normalised.length > 1 && normalised.endsWith('/')) normalised = normalised.slice(0, -1);
  return normalised;
}

/** Mirrors `isAlwaysCleartext` on the server. */
export function isAlwaysCleartext(path: string): boolean {
  const normalised = normalisePath(path);
  if (ALWAYS_CLEARTEXT_EXACT.includes(normalised)) return true;
  return ALWAYS_CLEARTEXT_PREFIXES.some(
    (prefix) => normalised === prefix || normalised.startsWith(`${prefix}/`),
  );
}

// --- helpers -------------------------------------------------------------------------------

/**
 * Parses the advertisement, falling back to `off` on anything unreadable.
 *
 * `off` rather than `full` is the right fallback here, and the direction is the opposite of the
 * server's fail-closed config parsing on purpose: a client that cannot read the policy and
 * encrypts anyway would send payloads the server may not be expecting on routes it treats as
 * cleartext, breaking the application outright. A client that does not encrypt still has TLS.
 */
function parsePolicy(raw: string | null): TransportPolicy {
  const off: TransportPolicy = { mode: 'off', routeOverrides: {}, fields: [] };
  if (raw === null) return off;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return off;
  }
  if (parsed === null || typeof parsed !== 'object') return off;

  const candidate = parsed as Partial<TransportPolicy>;
  if (!isMode(candidate.mode)) return off;

  const overrides: Record<string, TransportMode> = {};
  for (const [key, value] of Object.entries(candidate.routeOverrides ?? {})) {
    if (isMode(value)) overrides[normaliseRouteOverrideKey(key)] = value;
  }

  return {
    mode: candidate.mode,
    routeOverrides: overrides,
    fields: Array.isArray(candidate.fields)
      ? candidate.fields.filter((name): name is string => typeof name === 'string')
      : [],
  };
}

function isMode(value: unknown): value is TransportMode {
  return value === 'off' || value === 'fields' || value === 'full';
}

/**
 * `"POST  /Users"` → `"POST /users"`.
 *
 * Mirrors `normaliseRouteOverrideKey` in
 * `back-end/src/common/data-protection/data-protection.config.ts`, which the server applies to
 * the same keys before advertising them. 07-DATA-PROTECTION.md §5's own example writes
 * `"GET  /health"` with two spaces, so collapsing whitespace is not theoretical.
 */
export function normaliseRouteOverrideKey(key: string): string {
  const parts = key.trim().split(/\s+/);
  if (parts.length < 2) return key.trim().toLowerCase();
  const [method, ...rest] = parts;
  return `${method.toUpperCase()} ${rest.join(' ').toLowerCase()}`;
}

/** A JSON object or array — the only shapes an envelope is built from. */
function isJsonContainer(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !(value instanceof Date);
}

function joinPath(parent: string, child: string): string {
  return parent === '' ? child : `${parent}.${child}`;
}

/**
 * A type name for an error message. Never the error's own text: a WebCrypto `OperationError`
 * says nothing sensitive, but the habit of interpolating an unknown error into a user-visible
 * string is how internal detail reaches a screen.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}
