/**
 * T-RAP-012. AES-256-GCM encrypt/decrypt of `customerId` (`01-DATABASE.md` §3/§7 —
 * `customer_id_encrypted`) and HMAC-SHA-256 for the deterministic, queryable `customer_id_hash`
 * (`06-CONFIGURABILITY-AND-OBSERVABILITY.md` §1, `AGENT-PROTOCOL.md` R4).
 *
 * **Both keys are read directly from `process.env`, not `ConfigService`/`src/config/config.schema.ts`.**
 * That shared schema is `agent-rap-foundation`'s file scope (`src/config/**`), not this task's —
 * the exact same "the shared config schema is out of this file-scope owner's reach" reasoning
 * `campaign-config.client.ts`'s `loadCampaignConfigClientOptions()` and
 * `campaign-config-cache.service.ts`'s `resolveConfiguredTenantIds()` already documented for this
 * task's own sibling, T-RAP-010 (same owner, `agent-rap-cache`). **This is a deliberate deviation
 * from this task's own implementation note 3** ("Both keys come from required env vars, validated
 * by `ConfigModule` (T-RAP-001) at boot") — flagged in the completion report. The observable
 * boot-safety contract note 3 actually cares about — a missing/invalid key must crash the process
 * before it ever serves a request — still holds: `loadEncryptionKeyMaterial()` throws
 * synchronously, `EncryptionModule`'s own factory provider (see that file) calls it eagerly at
 * module-construction time, and Node 20's default unhandled-rejection behaviour (terminate
 * non-zero) takes it from there once a future task wires this module into `AppModule`/`main.ts` —
 * exactly the mechanism `main.ts`'s own top-level `bootstrap()` (no `.catch`) already relies on
 * for `ConfigModule`'s own validation failures today.
 *
 * No key material is ever logged, defaulted, or committed (R8) — `loadEncryptionKeyMaterial`
 * throws a descriptive error naming the missing/invalid *variable*, never a value, rather than
 * falling back to anything.
 */
import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const AES_ALGORITHM = 'aes-256-gcm';
/** 256-bit — AES-256-GCM's own fixed key size. */
const AES_KEY_BYTES = 32;
/** 96-bit — the standard/recommended GCM nonce size (NIST SP 800-38D). */
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
/** Not AES-256-GCM's own constraint (HMAC-SHA-256 accepts any key length) — this is R4's own
 * intent: never a short, guessable secret standing in for "a real key". */
const HMAC_KEY_MIN_BYTES = 32;

export interface EncryptionKeyMaterial {
  /** AES-256-GCM key — exactly 32 bytes. */
  aesKey: Buffer;
  /** HMAC-SHA-256 key — independent key material from `aesKey` (implementation note 2:
   * "different key material from the AES key"). */
  hmacKey: Buffer;
}

/**
 * Reads and validates `FIELD_ENCRYPTION_AES_KEY`/`FIELD_ENCRYPTION_HMAC_KEY` (both
 * base64-encoded) from `process.env`. Throws a descriptive `Error` — never calls `process.exit`
 * itself, matching `loadCampaignConfigClientOptions()`'s own precedent for a value consumed via a
 * factory provider's constructor call, not `ConfigModule`'s own top-level validator (TC-7).
 */
export function loadEncryptionKeyMaterial(): EncryptionKeyMaterial {
  const aesRaw = process.env.FIELD_ENCRYPTION_AES_KEY?.trim();
  if (!aesRaw) {
    throw new Error(
      'FIELD_ENCRYPTION_AES_KEY is required (base64-encoded 256-bit AES-GCM key) — ' +
        'no default, no fallback (AGENT-PROTOCOL.md R8)',
    );
  }
  const aesKey = Buffer.from(aesRaw, 'base64');
  if (aesKey.length !== AES_KEY_BYTES) {
    throw new Error(
      `FIELD_ENCRYPTION_AES_KEY must decode to exactly ${AES_KEY_BYTES} bytes (got ${aesKey.length}) ` +
        `— AES-256-GCM requires a 256-bit key`,
    );
  }

  const hmacRaw = process.env.FIELD_ENCRYPTION_HMAC_KEY?.trim();
  if (!hmacRaw) {
    throw new Error(
      'FIELD_ENCRYPTION_HMAC_KEY is required (base64-encoded key material, independent of ' +
        'FIELD_ENCRYPTION_AES_KEY) — no default, no fallback (AGENT-PROTOCOL.md R8)',
    );
  }
  const hmacKey = Buffer.from(hmacRaw, 'base64');
  if (hmacKey.length < HMAC_KEY_MIN_BYTES) {
    throw new Error(
      `FIELD_ENCRYPTION_HMAC_KEY must decode to at least ${HMAC_KEY_MIN_BYTES} bytes ` +
        `(got ${hmacKey.length})`,
    );
  }
  if (hmacKey.equals(aesKey)) {
    throw new Error(
      'FIELD_ENCRYPTION_HMAC_KEY must not be the same value as FIELD_ENCRYPTION_AES_KEY ' +
        '(implementation note 2: independent key material)',
    );
  }

  return { aesKey, hmacKey };
}

@Injectable()
export class EncryptionService {
  constructor(private readonly keys: EncryptionKeyMaterial) {}

  /**
   * AES-256-GCM encrypt. A fresh random IV every call (never reused, never derived —
   * implementation note 1). Returns `base64(iv || ciphertext || authTag)`, self-contained enough
   * to decrypt without any side-channel lookup — this is exactly the shape
   * `customer_id_encrypted` (`01-DATABASE.md` §3/§7) stores.
   */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(AES_ALGORITHM, this.keys.aesKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, ciphertext, authTag]).toString('base64');
  }

  /**
   * Inverse of `encrypt` (TC-1: round-trips exactly). Throws if the payload is malformed or the
   * GCM auth tag doesn't verify (tampered/corrupted ciphertext, or the wrong key) — `crypto`'s own
   * `decipher.final()` is what enforces the auth tag check, never bypassed here.
   */
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
   * Deterministic HMAC-SHA-256 (TC-2: same input, same output every time) under a server-side
   * secret key this method never exposes. This is what `customer_id_hash` (`01-DATABASE.md`
   * §3/§7) stores — **not** a claim of strong anonymization on its own (implementation note 2): a
   * hash of a small, guessable id space is not real anonymization. It exists purely so this value
   * can be used in unique indexes and equality lookups without ever storing the plaintext
   * (AGENT-PROTOCOL.md R4). Do not oversell this method's output as "anonymized" in any caller's
   * own comments/docs.
   */
  hash(value: string): string {
    return createHmac('sha256', this.keys.hmacKey).update(value, 'utf8').digest('hex');
  }
}
