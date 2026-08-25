/**
 * T-018 — the ECDH handshake that gives one session one transport key
 * (07-DATA-PROTECTION.md §5, task file implementation note 2).
 *
 * ```
 * LOGIN
 *   1. Browser generates an ECDH P-256 keypair, extractable: false
 *   2. Browser sends its public key on the login request  (X-Transport-Public-Key)
 *   3. Server derives the shared secret, HKDF-SHA256 → AES-256-GCM key      ← this file
 *   4. Server stores it in portal_sessions.transport_key_enc, encrypted at rest via T-016
 *   5. Server returns its own public key; the browser derives the identical key locally
 * ```
 *
 * ---
 *
 * ## Three choices in here that are load-bearing
 *
 * **1. The raw uncompressed SEC1 point, not SPKI/DER.** `crypto.createECDH()` and WebCrypto's
 * `exportKey('raw', …)` both produce `0x04 || X || Y` natively, so neither side needs an ASN.1
 * encoder and there is no format negotiation to get wrong. The length and the leading `0x04` are
 * checked before the point is handed to OpenSSL, and `computeSecret` rejects a point that is not
 * on the curve — that check is what closes the invalid-curve attack, in which a peer offers a
 * point on a weaker curve and recovers the private key from the resulting shared secrets.
 *
 * **2. HKDF, not "use the shared secret as the key".** The ECDH output is the X coordinate of a
 * curve point: 32 bytes with structure and bias, not a uniform key. Feeding it to AES directly is
 * a textbook mistake. The salt is the two public keys concatenated, which binds the derived key
 * to *this exact exchange* — a recorded handshake replayed with one key substituted derives a
 * different key and every subsequent payload fails its tag check.
 *
 * **3. The derived key is encrypted at rest before it is stored.** `transport_key_enc` is a
 * column in the same database as everything the key protects, so storing it in the clear would
 * mean one stolen backup contains both halves. It goes through T-016's `FieldCryptoService`, with
 * the session row's identity bound in as AAD, exactly like every other encrypted portal column —
 * so a `transport_key_enc` copied from one session row onto another fails to decrypt.
 *
 * ### Which key ring wraps it, and why it is `field` rather than `transport`
 *
 * T-016 defines four key purposes, one of which is `transport`. This task uses the **`field`**
 * ring, through `FieldCryptoService`, because the thing being protected here is *a column at
 * rest* — which is precisely what the `field` ring is for and what `FieldCryptoService` is the
 * only supported door to. The `transport` purpose would be the right ring for a long-lived
 * server-side transport key; this design has none, because the ECDH keypair is ephemeral and
 * per-login, which is a stronger property. `KeyRegistryService` still accepts a `transport` key
 * if a deployment defines one; nothing in this build consumes it. Recorded in the T-018
 * completion report so the unused ring is a known decision, not an oversight.
 *
 * ## A handshake that fails does not fail the login
 *
 * An unusable client public key is logged at `warn` and the login proceeds without a transport
 * key. The alternative — 400 on the login — would let a malformed header lock a user out of a
 * portal whose traffic is already protected by TLS, and would make a client-side bug in an
 * *optional* defence-in-depth layer look like a credential failure. The client can tell: it gets
 * no `X-Transport-Public-Key` back, so it knows not to encrypt. Every subsequent encrypted
 * request would in any case be answered 401 rather than being silently accepted in the clear.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createECDH, hkdfSync } from 'node:crypto';
import type { Request } from 'express';
import { FieldCryptoService } from '@/common/crypto';
import {
  SESSION_TRANSPORT_KEY_STORE,
  type SessionTransportKeyStore,
} from './session-transport-key.repository';
import { sessionKid } from './transport-crypto.constants';

/** What a completed handshake hands back to `AuthController` for the two response headers. */
export interface HandshakeResult {
  /** Base64 of the server's ephemeral uncompressed P-256 point. */
  readonly serverPublicKey: string;
  /** `sess_<session id>` — the value the client stamps into every envelope. */
  readonly kid: string;
}

/** P-256, in OpenSSL's spelling. The curve 07-DATA-PROTECTION.md §5 names. */
const CURVE = 'prime256v1';

/** `0x04 || X || Y` for P-256: one tag byte plus two 32-byte coordinates. */
export const UNCOMPRESSED_POINT_BYTES = 65;

/** SEC1's tag for an uncompressed point. A compressed point (`0x02`/`0x03`) is refused. */
const UNCOMPRESSED_POINT_TAG = 0x04;

/** AES-256. */
export const TRANSPORT_KEY_BYTES = 32;

/**
 * HKDF `info`. Domain separation: a key derived for this purpose can never collide with one
 * derived from the same secret for another. Changing this string invalidates every live session's
 * key — which is a deliberate, if blunt, way to force a global re-handshake.
 */
export const HKDF_INFO = 'reward-portal/transport/v1/aes-256-gcm';

/** The `portal_sessions` AAD container, schema-qualified as `FieldCryptoService.aadFor` requires. */
const SESSIONS_TABLE = 'reward_portal.portal_sessions';

/**
 * Where the resolved key is cached for the life of one request.
 *
 * A `Symbol`, for the reason `trace-id.ts` gives about its own cache: nothing else — including a
 * parsed request body — can collide with or forge a symbol-keyed property. It exists because both
 * interceptors need the key and a per-interceptor lookup would double the query count on every
 * encrypted request for no benefit.
 */
const REQUEST_KEY_CACHE = Symbol('rs.transportKey');

interface KeyCachingRequest extends Request {
  [REQUEST_KEY_CACHE]?: Promise<Buffer | null>;
}

@Injectable()
export class HandshakeService {
  private readonly logger = new Logger(HandshakeService.name);

  constructor(
    @Inject(SESSION_TRANSPORT_KEY_STORE) private readonly store: SessionTransportKeyStore,
    private readonly fieldCrypto: FieldCryptoService,
  ) {}

  /**
   * Completes the handshake for a freshly-issued session.
   *
   * Returns the server's public key and the `kid` the client must stamp into every envelope — or
   * `null` when no handshake happened, either because the client did not offer a key or because
   * the one it offered was unusable. See this file's header for why the second case is not an
   * error.
   */
  async establish(
    sessionId: string,
    clientPublicKeyBase64: string | undefined,
  ): Promise<HandshakeResult | null> {
    if (clientPublicKeyBase64 === undefined || clientPublicKeyBase64.length === 0) return null;

    const clientPublicKey = decodePoint(clientPublicKeyBase64);
    if (clientPublicKey === null) {
      this.logger.warn(
        `Transport handshake skipped for session ${sessionId}: the client public key is not a ` +
          `base64 uncompressed P-256 point. The session has no transport key; payload ` +
          `encryption is unavailable on it.`,
      );
      return null;
    }

    const ecdh = createECDH(CURVE);
    const serverPublicKey = ecdh.generateKeys();

    let shared: Buffer;
    try {
      shared = ecdh.computeSecret(clientPublicKey);
    } catch {
      // OpenSSL refused the point — it is not on P-256. This is the invalid-curve case; the
      // underlying message is not logged because it varies by OpenSSL build and says nothing an
      // operator can act on beyond what this line already says.
      this.logger.warn(
        `Transport handshake skipped for session ${sessionId}: the client public key is not a ` +
          `valid point on P-256.`,
      );
      return null;
    }

    const derived = deriveTransportKey(shared, clientPublicKey, serverPublicKey);
    // The shared secret has done its only job. Zero it before anything can await — a heap dump
    // taken later must not still contain it.
    shared.fill(0);

    try {
      const ciphertext = this.fieldCrypto.encrypt(derived.toString('base64'), {
        aad: FieldCryptoService.aadFor(SESSIONS_TABLE, sessionId),
      });
      const stored = await this.store.store(sessionId, ciphertext);
      if (!stored) {
        // The session was revoked between issuance and this write. Nothing to do, and nothing is
        // wrong: the client will get no server public key and will not encrypt.
        this.logger.warn(
          `Transport handshake for session ${sessionId} found no active session to store the ` +
            `key against; the session was revoked mid-login.`,
        );
        return null;
      }
    } catch (error) {
      // A missing `field` key ring, a database error, a wipe mid-rotation. Logged at `error`
      // because it is a real misconfiguration an operator must fix — but it does **not** fail the
      // login, for the reason this file's header gives: an optional defence-in-depth layer must
      // not be able to lock a user out of a portal whose traffic is already on TLS.
      this.logger.error(
        `Transport handshake failed for session ${sessionId} (${(error as Error).name}); the ` +
          `session has no transport key and payload encryption is unavailable on it.`,
      );
      return null;
    } finally {
      derived.fill(0);
    }

    return { serverPublicKey: serverPublicKey.toString('base64'), kid: sessionKid(sessionId) };
  }

  /**
   * The transport key for one session, or `null` when the session has none.
   *
   * `null` covers three cases that are all the same to the caller: the session never handshook,
   * the key was destroyed by logout, or the session is no longer `active`. The repository's
   * `status = 'active'` predicate is what folds the third into the other two — see its header.
   */
  async keyForSession(sessionId: string): Promise<Buffer | null> {
    const ciphertext = await this.store.find(sessionId);
    if (ciphertext === null) return null;

    try {
      const plaintext = this.fieldCrypto.decrypt(ciphertext, {
        aad: FieldCryptoService.aadFor(SESSIONS_TABLE, sessionId),
      });
      const key = Buffer.from(plaintext, 'base64');
      if (key.length !== TRANSPORT_KEY_BYTES) {
        this.logger.error(
          `transport_key_enc for session ${sessionId} decrypted to ${key.length} bytes, not ` +
            `${TRANSPORT_KEY_BYTES}. Treating the session as having no transport key.`,
        );
        return null;
      }
      return key;
    } catch (error) {
      // A key that will not decrypt is a key-registry problem (a retired kid, a rotated key that
      // was never re-encrypted), not a client problem. Fail closed: no key, so an encrypted
      // request is answered 401 and the client re-authenticates into a fresh handshake.
      this.logger.error(
        `transport_key_enc for session ${sessionId} could not be decrypted ` +
          `(${(error as Error).name}). The session is treated as having no transport key.`,
      );
      return null;
    }
  }

  /**
   * The transport key for the request's session, resolved at most once per request.
   *
   * The **session id comes from `request.authUser`**, which `JwtAuthGuard` populated from a
   * verified token, and from nowhere else (R3). The `kid` inside an envelope is never used to
   * look a key up; it is only ever compared against this one.
   */
  async keyForRequest(request: Request): Promise<Buffer | null> {
    const caching = request as KeyCachingRequest;
    const cached = caching[REQUEST_KEY_CACHE];
    if (cached !== undefined) return cached;

    const sessionId = (request as { authUser?: { sessionId?: unknown } }).authUser?.sessionId;
    const resolved =
      typeof sessionId === 'string' && sessionId.length > 0
        ? this.keyForSession(sessionId)
        : Promise.resolve(null);

    caching[REQUEST_KEY_CACHE] = resolved;
    return resolved;
  }

  /** Destroys one session's key — `POST /auth/logout` (task file implementation note 7). */
  async destroyForSession(sessionId: string): Promise<void> {
    await this.store.clearForSession(sessionId);
  }

  /** Destroys every key a user holds — `POST /auth/logout-all`. */
  async destroyForUser(userId: number): Promise<void> {
    await this.store.clearForUser(userId);
  }
}

/**
 * Decodes and validates a peer public key. Returns `null` for anything that is not a base64
 * uncompressed P-256 point — length and tag byte are checked *here*, on-curve-ness is checked by
 * `computeSecret`.
 *
 * `Buffer.from(s, 'base64')` silently skips characters outside the alphabet rather than failing,
 * so the exact length check below is doing real work: it is what stops a 65-byte prefix of a
 * longer garbage string from being accepted.
 */
export function decodePoint(base64: string): Buffer | null {
  // No `try` around this: `Buffer.from(s, 'base64')` never throws for a string input — it skips
  // characters outside the alphabet — so a catch here would be an untestable branch pretending to
  // be a safety net. The length check below is the control that actually rejects garbage.
  const point = Buffer.from(base64, 'base64');
  if (point.length !== UNCOMPRESSED_POINT_BYTES) return null;
  if (point[0] !== UNCOMPRESSED_POINT_TAG) return null;
  return point;
}

/**
 * HKDF-SHA256 over the ECDH shared secret.
 *
 * The salt is `clientPublicKey || serverPublicKey`, in that fixed order, so both sides compute it
 * from values they already hold and neither can be substituted after the fact. Exported so the
 * front-end library's derivation can be asserted against this one directly in a test, which is
 * the only way to be sure the two agree (T-018 TC-1).
 */
export function deriveTransportKey(
  sharedSecret: Buffer,
  clientPublicKey: Buffer,
  serverPublicKey: Buffer,
): Buffer {
  const salt = Buffer.concat([clientPublicKey, serverPublicKey]);
  return Buffer.from(
    hkdfSync('sha256', sharedSecret, salt, Buffer.from(HKDF_INFO, 'utf8'), TRANSPORT_KEY_BYTES),
  );
}
