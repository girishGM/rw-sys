/**
 * T-016 — the typed errors every crypto primitive throws.
 *
 * **These messages are part of the security surface.** They are written into logs and, via
 * T-014's error normaliser, potentially into API responses. Not one of them may contain
 * plaintext, key material, or a full ciphertext (07-DATA-PROTECTION.md §3; T-016
 * Implementation notes §8, TC-22). The only identifier allowed through is the `kid`, which
 * is a public key *label* — it travels in the clear inside every ciphertext already.
 *
 * The `reason` codes are deliberately coarse. A decryption failure must not tell an
 * attacker *why* it failed beyond "the input was structurally wrong" vs "authentication
 * failed" — and even that distinction is only kept because operators genuinely cannot debug
 * a rotation without it. There is no padding-oracle risk here (GCM is AEAD; the tag check
 * is all-or-nothing), which is what makes the distinction safe to expose at all.
 */

/** Why a decryption attempt failed. Coarse by design — see this file's header. */
export type DecryptionFailureReason =
  /** Not a `v1.<kid>.<iv>.<tag>.<ct>` string at all, or a field had the wrong length. */
  | 'malformed'
  /** Structurally fine, but the embedded `kid` is not in the key registry. */
  | 'unknown_key'
  /** The `kid` resolves to a key whose status is `retired` — decryption is refused. */
  | 'retired_key'
  /** A format version this build does not implement. */
  | 'unsupported_version'
  /** GCM tag check failed: tampered ciphertext, tampered tag, or the wrong AAD. */
  | 'auth_failed';

/**
 * Thrown by every failed decryption path. **Never** returned partially-decrypted data:
 * `FieldCryptoService.decrypt` buffers `update()` output internally and only converts it
 * to a string once `final()` (i.e. the GCM tag check) has succeeded.
 */
export class DecryptionError extends Error {
  readonly reason: DecryptionFailureReason;
  /** Present only when the envelope parsed far enough to expose one. A public label. */
  readonly kid?: string;

  constructor(reason: DecryptionFailureReason, kid?: string) {
    super(kid ? `Decryption failed (${reason}, kid=${kid})` : `Decryption failed (${reason})`);
    this.name = 'DecryptionError';
    this.reason = reason;
    this.kid = kid;
    Error.captureStackTrace?.(this, DecryptionError);
  }
}

/**
 * Thrown when a caller asks for encryption that cannot be performed safely — a missing AAD,
 * a non-string plaintext, no active key. Every one of these is a programming error, and
 * every one of them fails closed: nothing is written rather than something being written
 * unbound or unencrypted.
 */
export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
    Error.captureStackTrace?.(this, EncryptionError);
  }
}

/**
 * Thrown while loading the key registry. Any instance of this at boot **must** stop the
 * process: a portal that starts with a broken key registry will happily write rows it can
 * never read back, or — far worse — fall back to something weaker without anyone noticing.
 * There is no degraded mode here on purpose.
 */
export class KeyRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyRegistryError';
    Error.captureStackTrace?.(this, KeyRegistryError);
  }
}

/** Thrown when a blind index cannot be computed safely (unknown normaliser, no key). */
export class BlindIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlindIndexError';
    Error.captureStackTrace?.(this, BlindIndexError);
  }
}
