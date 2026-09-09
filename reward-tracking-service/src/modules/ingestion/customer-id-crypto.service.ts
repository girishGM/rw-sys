/**
 * T-RTS-010. AES-256-GCM encrypt/decrypt of `customerId` (`reward_fact.customer_id_encrypted`) plus
 * HMAC-SHA-256 for the deterministic, queryable `customer_id_hash` — the primitive `AGENT-PROTOCOL.md`
 * R6 ("`customerId` is encrypted + hashed at rest, always") requires this service to have before it
 * can write a single `reward_fact` row.
 *
 * **Known plan gap, flagged rather than silently worked around (`AGENT-PROTOCOL.md` §7 — "a required
 * piece of infrastructure ... doesn't actually exist").** Every sibling service with the same R6-shaped
 * rule (`reward-redemption-service`, `realtime-activity-processing-service`) has its own dedicated
 * Wave-0 foundation task that builds a full `encryption` module (`EncryptionService` +
 * `FieldEncryptionConfigRepository` + `LogRedactorService`, keyed off a `field_encryption_config` DB
 * table — see `reward-redemption-service/src/modules/encryption/` and that plan's own `T-RR-005`).
 * No equivalent task exists anywhere in `reward-tracking-service-plan/tasks/` — confirmed by a direct
 * grep for "encrypt" across every task file before writing this one. T-RTS-010's own "Files owned"
 * list has no encryption file either, and adding a `field_encryption_config` table is out of this
 * task's file scope (`src/database/migrations/**` belongs to `agent-rts-foundation`, R10). Rather than
 * block this whole wave (5 tasks deep) on a plan gap a human can fix by simply filing the missing
 * foundation task, this file provides the minimal primitive T-RTS-010 itself needs — a direct,
 * verbatim port of `reward-redemption-service/src/modules/encryption/encryption.service.ts`'s own
 * algorithm/key-handling/error-handling shape (AES-256-GCM with a fresh IV per call, `base64(iv ||
 * ciphertext || authTag)`, HMAC-SHA-256 for the hash) — **without** the `field_encryption_config`
 * on/off gate or `LogRedactorService`, since neither has anywhere to live in this task's own scope and
 * neither is required by this service's own R6 text (unlike RR's own, separately-chosen design). This
 * is flagged in the completion report as a deviation for the architect to reconcile (e.g. by filing a
 * real `T-RTS-0xx` "encryption module" foundation task later and having this service migrate onto it).
 *
 * Keys are read directly from `process.env` (`FIELD_ENCRYPTION_AES_KEY`/`FIELD_ENCRYPTION_HMAC_KEY`),
 * not through `src/config/config.schema.ts` — that file is `agent-rts-foundation`'s own (R10), and RR's
 * own precedent already establishes this exact "the encryption module validates its own env vars
 * itself" split (`encryption.service.ts`'s own header there). A missing/malformed key throws
 * synchronously and loudly (R12 — no default, no silent fallback), the same fail-fast contract RR's
 * own `loadEncryptionKeyMaterial` establishes.
 */
import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const AES_ALGORITHM = 'aes-256-gcm';
/** 256-bit — AES-256-GCM's own fixed key size. */
const AES_KEY_BYTES = 32;
/** 96-bit — the standard/recommended GCM nonce size (NIST SP 800-38D). */
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
/** Not AES-256-GCM's own constraint (HMAC-SHA-256 accepts any key length) — R12's own intent: never
 * a short, guessable secret standing in for "a real key". */
const HMAC_KEY_MIN_BYTES = 32;

export interface CustomerIdCryptoKeyMaterial {
  /** AES-256-GCM key — exactly 32 bytes. */
  aesKey: Buffer;
  /** HMAC-SHA-256 key — independent key material from `aesKey`. */
  hmacKey: Buffer;
}

/**
 * Reads and validates `FIELD_ENCRYPTION_AES_KEY`/`FIELD_ENCRYPTION_HMAC_KEY` (both base64-encoded)
 * from `process.env`. Throws a descriptive `Error` rather than calling `process.exit` itself, so a
 * factory provider (or a test) can decide what to do with the failure.
 */
export function loadCustomerIdCryptoKeyMaterial(): CustomerIdCryptoKeyMaterial {
  const aesRaw = process.env.FIELD_ENCRYPTION_AES_KEY?.trim();
  if (!aesRaw) {
    throw new Error(
      'FIELD_ENCRYPTION_AES_KEY is required (base64-encoded 256-bit AES-GCM key) — no default, no ' +
        'fallback (AGENT-PROTOCOL.md R6/R12).',
    );
  }
  const aesKey = Buffer.from(aesRaw, 'base64');
  if (aesKey.length !== AES_KEY_BYTES) {
    throw new Error(
      `FIELD_ENCRYPTION_AES_KEY must decode to exactly ${AES_KEY_BYTES} bytes (got ${aesKey.length}) ` +
        '— AES-256-GCM requires a 256-bit key.',
    );
  }

  const hmacRaw = process.env.FIELD_ENCRYPTION_HMAC_KEY?.trim();
  if (!hmacRaw) {
    throw new Error(
      'FIELD_ENCRYPTION_HMAC_KEY is required (base64-encoded key material, independent of ' +
        'FIELD_ENCRYPTION_AES_KEY) — no default, no fallback (AGENT-PROTOCOL.md R6/R12).',
    );
  }
  const hmacKey = Buffer.from(hmacRaw, 'base64');
  if (hmacKey.length < HMAC_KEY_MIN_BYTES) {
    throw new Error(
      `FIELD_ENCRYPTION_HMAC_KEY must decode to at least ${HMAC_KEY_MIN_BYTES} bytes (got ${hmacKey.length}).`,
    );
  }
  if (hmacKey.equals(aesKey)) {
    throw new Error(
      'FIELD_ENCRYPTION_HMAC_KEY must not be the same value as FIELD_ENCRYPTION_AES_KEY ' +
        '(independent key material required).',
    );
  }

  return { aesKey, hmacKey };
}

@Injectable()
export class CustomerIdCryptoService {
  constructor(private readonly keys: CustomerIdCryptoKeyMaterial) {}

  /**
   * AES-256-GCM encrypt. A fresh random IV every call (never reused, never derived). Returns
   * `base64(iv || ciphertext || authTag)` — self-contained enough to decrypt without any
   * side-channel lookup, exactly the shape `reward_fact.customer_id_encrypted` stores.
   */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(AES_ALGORITHM, this.keys.aesKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, ciphertext, authTag]).toString('base64');
  }

  /** Inverse of `encrypt`. Throws if the payload is malformed or the GCM auth tag doesn't verify
   * (tampered/corrupted ciphertext, or the wrong key). Not called anywhere in this task's own scope
   * (nothing here needs to recover plaintext yet) — provided for symmetry/completeness and for
   * whichever later task first needs to display a decrypted value. */
  decrypt(encoded: string): string {
    const raw = Buffer.from(encoded, 'base64');
    if (raw.length < IV_BYTES + AUTH_TAG_BYTES) {
      throw new Error('Malformed ciphertext: too short to contain an IV and an auth tag');
    }
    const iv = raw.subarray(0, IV_BYTES);
    const authTag = raw.subarray(raw.length - AUTH_TAG_BYTES);
    const ciphertext = raw.subarray(IV_BYTES, raw.length - AUTH_TAG_BYTES);

    const decipher = createDecipheriv(AES_ALGORITHM, this.keys.aesKey, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  }

  /**
   * Deterministic HMAC-SHA-256 (same input, same output every time) under a server-side secret key
   * this method never exposes — what `reward_fact.customer_id_hash` stores. Not a claim of strong
   * anonymization on its own; it exists purely so this value can be used in an equality lookup
   * without ever storing the plaintext (R6). Never reimplemented via `encrypt` — different
   * primitives serving different purposes (encrypt = reversible/non-deterministic, hash = one-way/
   * deterministic lookup key).
   */
  hash(value: string): string {
    return createHmac('sha256', this.keys.hmacKey).update(value, 'utf8').digest('hex');
  }
}
