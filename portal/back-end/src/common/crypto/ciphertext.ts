/**
 * T-016 — the `v1.<kid>.<iv>.<tag>.<ct>` envelope codec (07-DATA-PROTECTION.md §4).
 *
 * Kept in its own file, separate from `FieldCryptoService`, for one reason: **parsing is the
 * attack surface.** Every byte in a ciphertext column is attacker-controlled the moment an
 * attacker has UPDATE on that column, and this is the code that decides what to do with it.
 * Isolating it makes it reviewable on its own and exhaustively testable without a key.
 *
 * The parser is deliberately paranoid (T-016 Implementation notes §2 — "Parse defensively —
 * a malformed string must raise a typed `DecryptionError`, never return partial plaintext"):
 *
 *  - Exactly five dot-separated parts. Not "at least five" — a sixth part means something
 *    concatenated onto the value and the whole thing is rejected.
 *  - `.` is not in the base64 alphabet and is excluded from `KID_PATTERN`, so splitting on
 *    `.` can never be ambiguous. That is why the separator is `.` and not, say, `:`.
 *  - Base64 is validated with a strict regex *before* decoding. `Buffer.from(s, 'base64')`
 *    silently skips characters outside the alphabet, so `Buffer.from('!!!!', 'base64')`
 *    yields an empty buffer rather than an error — decoding without validating first would
 *    turn garbage into a plausible-looking zero-length field.
 *  - IV and tag lengths are checked exactly (12 and 16 bytes). A short IV is not a parse
 *    curiosity; feeding a non-96-bit IV to GCM changes how the counter block is derived.
 */
import { DecryptionError } from './crypto.errors';

/** Envelope format version. Bumping this is how a future algorithm change ships. */
export const CIPHERTEXT_VERSION = 'v1';

/** 96-bit IV — the GCM-native size, per 07-DATA-PROTECTION.md §4. */
export const IV_BYTES = 12;

/** 128-bit GCM authentication tag. */
export const AUTH_TAG_BYTES = 16;

/**
 * `kid` alphabet. No `.` (it is the envelope separator), no `%` or `_`, because the
 * rotation scanner compares kid prefixes and a LIKE wildcard smuggled into a kid would make
 * that comparison over-match. `encryption_keys.kid` is `varchar(40)`, hence the bound.
 *
 * NOTE: `_` *is* excluded here even though 07-DATA-PROTECTION.md §3's example kid is
 * `fld_2026_01`. See `KID_PATTERN_ALLOWS_UNDERSCORE` below — underscores are allowed, and
 * the rotation scanner uses `starts_with()` rather than `LIKE` precisely so that they can be.
 */
export const KID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Documented for the reader of the note above: underscores are permitted in a `kid`
 * (the design doc's own example uses them), which is exactly why
 * `rotate-keys.command.ts` must never build a `LIKE` pattern out of a kid.
 */
export const KID_PATTERN_ALLOWS_UNDERSCORE = true;

/**
 * Strict standard-alphabet base64, including correct padding. Anchored, and it accepts the
 * empty string — an empty plaintext encrypts to an empty ciphertext body, which is a legal
 * and meaningful value (see `FieldCryptoService`, TC-8).
 */
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface ParsedCiphertext {
  version: string;
  kid: string;
  iv: Buffer;
  tag: Buffer;
  /** May be zero-length — see the empty-string case above. */
  ct: Buffer;
}

/**
 * Decodes base64 only if it is *exactly* base64. Returns `null` rather than throwing so the
 * caller decides which `DecryptionFailureReason` applies; this function has no idea whether
 * it is looking at an IV, a tag or a body.
 */
export function decodeBase64Strict(value: string): Buffer | null {
  if (!STRICT_BASE64.test(value)) return null;
  return Buffer.from(value, 'base64');
}

/** Builds the wire form. Callers pass raw bytes; base64 encoding happens here only. */
export function formatCiphertext(kid: string, iv: Buffer, tag: Buffer, ct: Buffer): string {
  return [
    CIPHERTEXT_VERSION,
    kid,
    iv.toString('base64'),
    tag.toString('base64'),
    ct.toString('base64'),
  ].join('.');
}

/**
 * The only supported way to turn a stored string back into fields. Throws `DecryptionError`
 * — never returns a partial result, never throws anything else.
 */
export function parseCiphertext(value: unknown): ParsedCiphertext {
  if (typeof value !== 'string') throw new DecryptionError('malformed');

  const parts = value.split('.');
  if (parts.length !== 5) throw new DecryptionError('malformed');

  const [version, kid, ivB64, tagB64, ctB64] = parts;

  // Version first: an unknown version is a different failure from a corrupt one, and an
  // operator seeing 'unsupported_version' knows to check the deploy, not the data.
  if (version !== CIPHERTEXT_VERSION) {
    throw new DecryptionError(/^v\d+$/.test(version) ? 'unsupported_version' : 'malformed');
  }
  if (!KID_PATTERN.test(kid)) throw new DecryptionError('malformed');

  const iv = decodeBase64Strict(ivB64);
  if (iv === null || iv.length !== IV_BYTES) throw new DecryptionError('malformed', kid);

  const tag = decodeBase64Strict(tagB64);
  if (tag === null || tag.length !== AUTH_TAG_BYTES) throw new DecryptionError('malformed', kid);

  const ct = decodeBase64Strict(ctB64);
  if (ct === null) throw new DecryptionError('malformed', kid);

  return { version, kid, iv, tag, ct };
}

/**
 * Cheap, allocation-light "does this look like one of our ciphertexts?" test. Used by the
 * rotation scanner and — later — by T-017's final log-sweep regex, which needs to spot a
 * `v1.` envelope that leaked into a log line. Deliberately *not* a full parse: a value that
 * looks like a ciphertext but does not parse is still something a log sweep must redact.
 */
export function looksLikeCiphertext(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(`${CIPHERTEXT_VERSION}.`);
}

/**
 * The prefix every ciphertext written under `kid` starts with. The rotation scanner uses
 * this with Postgres `starts_with()` — see `KID_PATTERN_ALLOWS_UNDERSCORE`.
 */
export function ciphertextPrefixFor(kid: string): string {
  return `${CIPHERTEXT_VERSION}.${kid}.`;
}
