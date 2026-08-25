/**
 * T-018 — the `{ kid, iv, tag, ct }` transport envelope, and the AAD that binds it to one
 * request (07-DATA-PROTECTION.md §5).
 *
 * Kept apart from the interceptors for the reason `ciphertext.ts` gives about the at-rest codec:
 * **parsing is the attack surface.** Every byte reaching {@link openEnvelope} is attacker-supplied
 * — it arrived in an HTTP body — so the code that decides what to do with it is isolated, has no
 * dependency on Nest, and is exhaustively testable without a server or a database.
 *
 * ---
 *
 * ## The AAD is the whole of the replay defence
 *
 * AES-GCM guarantees that a ciphertext was produced by somebody holding the key. It says nothing
 * about *which request* it was produced for. Without additional authenticated data, an envelope
 * captured from `POST /users` could be replayed verbatim into `POST /auth/change-password`, and a
 * field envelope lifted out of `oldPassword` could be dropped into `newPassword` — both decrypt
 * perfectly, because both are the same key and the same session.
 *
 * So every envelope binds five things it must agree with, from {@link buildAad}:
 *
 * | part | closes |
 * |---|---|
 * | version | a future v2 framing being fed to a v1 reader |
 * | `kid` | swapping the session id in the envelope header (it is authenticated, not just read) |
 * | direction (`req`/`res`) | replaying a *response* envelope back as a *request* body |
 * | correlation id | replaying yesterday's envelope on today's request — the task file's note 9 |
 * | field path | moving an envelope from one field of the same body to another |
 *
 * None of these is secret; AAD is not encrypted and does not need to be. What it gives is that
 * changing any of them turns a valid envelope into a tag failure.
 *
 * ## What this file does *not* claim
 *
 * It does not stop a script running in the page from calling `sealEnvelope`'s browser counterpart
 * with whatever it likes. Payload encryption protects against TLS-terminating proxies, logging
 * middleboxes and hop-by-hop capture — not against XSS. See `transport-crypto.module.ts`'s header
 * for the full statement of the limitation, and 02-SECURITY.md for the controls that *do* address
 * XSS (strict CSP, httpOnly cookies).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AUTH_TAG_BYTES, decodeBase64Strict, IV_BYTES } from '@/common/crypto';
import { TRANSPORT_ENVELOPE_VERSION } from './transport-crypto.constants';

const GCM = 'aes-256-gcm';

/** The path component of the AAD for a whole-body (`full` mode) envelope. */
export const WHOLE_BODY_PATH = '$';

/** Which way a payload is travelling. Authenticated, so the two can never be confused. */
export type PayloadDirection = 'req' | 'res';

/** The wire form, exactly as 07-DATA-PROTECTION.md §5 writes it. */
export interface PayloadEnvelope {
  readonly kid: string;
  readonly iv: string;
  readonly tag: string;
  readonly ct: string;
}

/** Everything that must match for an envelope to open. See this file's header. */
export interface EnvelopeBinding {
  readonly kid: string;
  readonly direction: PayloadDirection;
  readonly correlationId: string;
  /** `$` for a whole body, else the dotted path of the field (`policies.0.secret`). */
  readonly path: string;
}

/** Why an envelope could not be opened. Server-log only — never sent to a client. */
export type EnvelopeFailureReason =
  'not_an_envelope' | 'malformed' | 'auth_failed' | 'not_json' | 'not_a_body';

/**
 * Raised by {@link openEnvelope}. Carries a machine-readable reason for the server log and
 * nothing that could be echoed back — the interceptor answers a bare `PAYLOAD_DECRYPT_FAILED`
 * whichever reason this is (task file implementation note 8).
 */
export class EnvelopeError extends Error {
  constructor(readonly reason: EnvelopeFailureReason) {
    super(`Transport envelope could not be opened (${reason}).`);
    this.name = 'EnvelopeError';
    Error.captureStackTrace?.(this, EnvelopeError);
  }
}

/**
 * The exact key set of an envelope.
 *
 * Recognition is by **exact shape**, not by a marker property, because 07-DATA-PROTECTION.md §5
 * fixes the whole-body form as these four keys and nothing else — adding a discriminator would
 * put this implementation off-spec. Requiring the set to match exactly (not merely to contain
 * these four) is what keeps a legitimate DTO object from being mistaken for an envelope in
 * `fields` mode: a body object that happens to carry a `ct` *and* a `kid` *and* an `iv` *and* a
 * `tag`, all strings, and no other property, does not exist in this API.
 */
const ENVELOPE_KEYS: readonly string[] = Object.freeze(['kid', 'iv', 'tag', 'ct']);

/** Whether `value` is shaped like an envelope. Does not attempt to decode it. */
export function isPayloadEnvelope(value: unknown): value is PayloadEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== ENVELOPE_KEYS.length) return false;
  const candidate = value as Record<string, unknown>;
  return ENVELOPE_KEYS.every((key) => typeof candidate[key] === 'string');
}

/**
 * The authenticated-but-unencrypted context of one envelope.
 *
 * `|` is the separator and no component may contain it: version and direction are literals, `kid`
 * is `sess_` + a UUID, the correlation id is checked against `CORRELATION_ID_PATTERN` (which
 * excludes `|`) before it ever reaches here, and the path is built from JSON keys. A key
 * containing `|` could in principle make two different paths produce the same AAD; that is
 * harmless — it would let a field be swapped with another field of the same object, which is
 * strictly less than the no-AAD case, and no DTO in this application has such a key.
 */
export function buildAad(binding: EnvelopeBinding): Buffer {
  return Buffer.from(
    [
      TRANSPORT_ENVELOPE_VERSION,
      binding.kid,
      binding.direction,
      binding.correlationId,
      binding.path,
    ].join('|'),
    'utf8',
  );
}

/**
 * Encrypts one UTF-8 string into an envelope.
 *
 * A fresh 96-bit random IV per call, for exactly the reason `field-crypto.service.ts` sets out at
 * length: GCM is a counter mode, and a repeated (key, IV) pair leaks the XOR of two plaintexts
 * *and* the authentication subkey. There is no cache, no counter and no derivation here, and a
 * test that wants deterministic output is a test asking for the one thing this must never do.
 */
export function sealEnvelope(
  key: Buffer,
  plaintext: string,
  binding: EnvelopeBinding,
): PayloadEnvelope {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(GCM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(buildAad(binding));

  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    kid: binding.kid,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

/**
 * Opens an envelope, or throws {@link EnvelopeError}. Never throws anything else, and never
 * returns anything that has not passed the GCM tag check.
 *
 * As in `field-crypto.service.ts`: `decipher.update()` returns plaintext *before* the tag is
 * verified and only `final()` performs the check, so the `update()` output is held in a Buffer
 * and converted to a string only after `final()` has returned. Returning early here would turn
 * authenticated encryption back into unauthenticated CTR mode.
 */
export function openEnvelope(key: Buffer, envelope: unknown, binding: EnvelopeBinding): string {
  if (!isPayloadEnvelope(envelope)) throw new EnvelopeError('not_an_envelope');

  // The kid inside the envelope must be the one the caller expects. It is checked here *and*
  // authenticated through the AAD: the check produces a clean, specific failure, and the AAD
  // makes a forged one impossible even if this check were ever removed.
  if (envelope.kid !== binding.kid) throw new EnvelopeError('malformed');

  const iv = decodeBase64Strict(envelope.iv);
  if (iv === null || iv.length !== IV_BYTES) throw new EnvelopeError('malformed');

  const tag = decodeBase64Strict(envelope.tag);
  if (tag === null || tag.length !== AUTH_TAG_BYTES) throw new EnvelopeError('malformed');

  const ct = decodeBase64Strict(envelope.ct);
  if (ct === null) throw new EnvelopeError('malformed');

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(GCM, key, iv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(buildAad(binding));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    // The underlying message is swallowed deliberately — see `field-crypto.service.ts`. Node's
    // is accurate, but re-throwing it verbatim would let an unrelated OpenSSL error masquerade
    // as an authentication failure in the log.
    throw new EnvelopeError('auth_failed');
  }

  return plaintext.toString('utf8');
}

/**
 * Opens a **whole-body** envelope and parses the JSON inside it.
 *
 * The result must be an object or an array, i.e. something that could have been a request body
 * in the first place. A bare `"string"` or `7` is valid JSON and is rejected: `request.body` is
 * replaced with this value, and handing `ValidationPipe` a number where it expects a DTO is a
 * confusing 500 rather than an honest 400.
 */
export function openBodyEnvelope(
  key: Buffer,
  envelope: unknown,
  binding: EnvelopeBinding,
): Record<string, unknown> | unknown[] {
  const json = openEnvelope(key, envelope, binding);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new EnvelopeError('not_json');
  }

  if (parsed === null || typeof parsed !== 'object') throw new EnvelopeError('not_a_body');
  return parsed as Record<string, unknown> | unknown[];
}
