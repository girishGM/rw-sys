/**
 * T-016 — authenticated field encryption (07-DATA-PROTECTION.md §4).
 *
 * AES-256-GCM, a fresh 96-bit IV per operation, and the record's identity bound in as
 * additional authenticated data. Four properties this file exists to guarantee, in the order
 * they matter:
 *
 * 1. **The IV is fresh, random and never derived** (Implementation notes §4). GCM is a
 *    counter mode: reusing an (key, IV) pair leaks the XOR of the two plaintexts *and*
 *    hands an attacker the authentication subkey, which forges tags for everything under
 *    that key. `randomBytes(12)` on every single call, no caching, no counters, no
 *    "derive it from the primary key so it's deterministic". If you are reading this
 *    because a test wants deterministic ciphertext: the test is wrong, TC-2 asserts the
 *    opposite on purpose.
 *
 * 2. **The record identity is bound as AAD** (Implementation notes §3). Without it a
 *    ciphertext lifted out of row A and written into row B decrypts perfectly, so anyone
 *    with UPDATE on that column can move one user's encrypted email onto another user's
 *    row. With it, the tag check fails. This is TC-6, and it is the single cheapest control
 *    in this file.
 *
 * 3. **No partial plaintext ever escapes.** Node's `decipher.update()` returns plaintext
 *    *before* the tag has been verified; only `final()` performs the check. So `update()`
 *    output is held in a Buffer and converted to a string only after `final()` returns.
 *    Returning early here would silently turn AEAD back into unauthenticated CTR mode.
 *
 * 4. **`createCipheriv`, never `createCipher`.** The deprecated `createCipher` derives its
 *    own IV from the password with MD5 and reuses it for every call — catastrophic under
 *    GCM. T-016 verification step 6 greps for it.
 */
import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  AUTH_TAG_BYTES,
  CIPHERTEXT_VERSION,
  formatCiphertext,
  IV_BYTES,
  parseCiphertext,
} from './ciphertext';
import { DecryptionError, EncryptionError } from './crypto.errors';
import { KeyRegistryService } from './key-registry.service';

const GCM = 'aes-256-gcm';

export interface FieldCryptoOptions {
  /**
   * The record's identity, e.g. `reward_portal.portal_users:42`. Build it with
   * `FieldCryptoService.aadFor()` rather than by hand so the format stays consistent —
   * a change in how this string is composed invalidates every existing ciphertext, exactly
   * like a blind-index normalisation change does.
   */
  aad: string;
}

@Injectable()
export class FieldCryptoService {
  constructor(private readonly keys: KeyRegistryService) {}

  /**
   * The canonical AAD for a row. `table` should be schema-qualified so
   * `reward_portal.users:1` and `reward_config.users:1` can never collide.
   */
  static aadFor(table: string, primaryKey: string | number): string {
    if (table.length === 0) {
      throw new EncryptionError('aadFor() requires a non-empty table name.');
    }
    const pk = String(primaryKey);
    if (pk.length === 0) {
      throw new EncryptionError('aadFor() requires a non-empty primary key.');
    }
    return `${table}:${pk}`;
  }

  encrypt(plaintext: string, options: FieldCryptoOptions): string;
  encrypt(plaintext: string | null | undefined, options: FieldCryptoOptions): string | null;
  /**
   * Encrypts one field value.
   *
   * **Null handling (TC-8), documented because it is load-bearing for T-017's model hooks:**
   * `null`/`undefined` in returns `null` out — a NULL column stays NULL, because encrypting
   * "there is no value here" would both waste a row's worth of ciphertext and make the
   * column's NOT NULL-ness meaningless. The **empty string is a real value** and is
   * encrypted normally, producing a valid envelope with a zero-length body; it round-trips
   * back to `''`. `null` and `''` are therefore distinguishable after a round trip, which is
   * the behaviour a database column needs.
   */
  encrypt(plaintext: string | null | undefined, options: FieldCryptoOptions): string | null {
    const aad = assertAad(options, 'encrypt');
    if (plaintext === null || plaintext === undefined) return null;
    if (typeof plaintext !== 'string') {
      throw new EncryptionError(
        'encrypt() accepts a string, null or undefined. Serialise other types explicitly at ' +
          'the call site — an implicit String() here would silently store "[object Object]".',
      );
    }

    const key = this.keys.getActiveKey('field');
    const iv = randomBytes(IV_BYTES);

    const cipher = createCipheriv(GCM, key.material, iv, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(bindAad(key.kid, aad));

    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return formatCiphertext(key.kid, iv, tag, ct);
  }

  decrypt(ciphertext: string, options: FieldCryptoOptions): string;
  decrypt(ciphertext: string | null | undefined, options: FieldCryptoOptions): string | null;
  /**
   * Decrypts one field value, or throws `DecryptionError`. Never throws anything else, and
   * never returns anything that has not passed the GCM tag check.
   *
   * `null`/`undefined` in returns `null` out, mirroring `encrypt`. The **empty string is
   * rejected** rather than treated as "no value": an empty column where a ciphertext was
   * expected means data loss or a failed write, and quietly returning `''` would hide it.
   */
  decrypt(ciphertext: string | null | undefined, options: FieldCryptoOptions): string | null {
    const aad = assertAad(options, 'decrypt');
    if (ciphertext === null || ciphertext === undefined) return null;

    const parsed = parseCiphertext(ciphertext);
    const key = this.keys.getKeyForDecryption(parsed.kid);

    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv(GCM, key.material, parsed.iv, {
        authTagLength: AUTH_TAG_BYTES,
      });
      decipher.setAAD(bindAad(parsed.kid, aad));
      decipher.setAuthTag(parsed.tag);
      // Both halves inside the try, and nothing returned until final() has verified the tag.
      plaintext = Buffer.concat([decipher.update(parsed.ct), decipher.final()]);
    } catch {
      // Deliberately swallows the underlying message. Node's is "Unsupported state or unable
      // to authenticate data", which is fine, but re-throwing it verbatim would let an
      // unrelated OpenSSL error masquerade as an authentication failure.
      throw new DecryptionError('auth_failed', parsed.kid);
    }

    return plaintext.toString('utf8');
  }

  /**
   * Convenience for T-017's hooks and for `RotateKeysCommand`: re-encrypt an existing value
   * under whatever key is currently active, keeping the same AAD. Returns the input
   * unchanged when it is already on the active kid, so calling it is idempotent and cheap.
   */
  reencrypt(ciphertext: string, options: FieldCryptoOptions): string {
    const parsed = parseCiphertext(ciphertext);
    const active = this.keys.getActiveKey('field');
    if (parsed.kid === active.kid) return ciphertext;
    return this.encrypt(this.decrypt(ciphertext, options), options);
  }
}

/**
 * The bytes actually fed to GCM as AAD.
 *
 * The caller's record identity is prefixed with the envelope's own version and `kid`, so
 * those two header fields are authenticated too and cannot be rewritten in place. The
 * caller's string is last, so it can contain anything (including `.`) without making the
 * composition ambiguous.
 */
function bindAad(kid: string, aad: string): Buffer {
  return Buffer.from(`${CIPHERTEXT_VERSION}.${kid}.${aad}`, 'utf8');
}

/**
 * A missing AAD is the mistake Implementation notes §3 exists to prevent, so it is an error
 * rather than a default. There is no `encrypt(value)` overload on purpose: making the safe
 * thing the only thing is worth the extra argument at every call site.
 */
function assertAad(options: FieldCryptoOptions | undefined, operation: string): string {
  const aad = options?.aad;
  if (typeof aad !== 'string' || aad.length === 0) {
    throw new EncryptionError(
      `${operation}() requires a non-empty options.aad binding the record's identity ` +
        `(e.g. FieldCryptoService.aadFor('reward_portal.portal_users', id)). Without it a ` +
        `ciphertext copied from one row into another decrypts successfully ` +
        `(07-DATA-PROTECTION.md §4).`,
    );
  }
  return aad;
}
