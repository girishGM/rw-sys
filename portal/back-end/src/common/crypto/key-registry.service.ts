/**
 * T-016 — the key registry (07-DATA-PROTECTION.md §3).
 *
 * Loads `reward_portal.encryption_keys` once, at boot, resolves every `key_ref` pointer into
 * memory, and refuses to start if anything about that set of keys is wrong. Nothing in this
 * class has a degraded mode. Every check below fails the boot rather than continuing,
 * because the alternative — a portal that starts with a subtly wrong key set — writes rows
 * it can never read, or reads rows it should not be able to.
 *
 * ### Why raw SQL rather than a Sequelize model + `ScopedRepository`
 *
 * AGENT-PROTOCOL R2 requires request-time data access to go through `ScopedRepository`
 * (T-013). That is a **tenancy** control: it injects `tenant_id`/`country_id`/`merchant_id`
 * into the WHERE clause from the request's `ScopeContext`. `encryption_keys` has none of
 * those columns — it is global infrastructure — and this query runs at module init, before
 * any request exists, where `ScopeContext.require()` would (correctly) throw. So
 * `ScopedRepository` is not merely unnecessary here, it is structurally inapplicable.
 *
 * The access is therefore raw, parameterised SQL through the shared `Sequelize` instance —
 * the same convention `src/common/caps/legacy-budget-sync.ts` already uses, and the same one
 * every migration uses. This is deliberately *not* `EncryptionKey.findAll()`: T-013's
 * `no-raw-model-access` lint rule bans model statics outside `src/common/scope/` and
 * `src/database/`, and this file must pass that rule without an `eslint-disable`
 * (R2: "The lint rule that enforces this must not be disabled"). Flagged for the reviewer in
 * the T-016 completion report.
 */
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { KID_PATTERN } from './ciphertext';
import { DecryptionError, KeyRegistryError } from './crypto.errors';
import {
  KEY_MATERIAL_RESOLVERS,
  type KeyMaterialResolver,
  parseKeyRef,
} from './key-material.resolver';

/** Key rings, per 07-DATA-PROTECTION.md §3 (`encryption_keys.purpose`). */
export type KeyPurpose = 'field' | 'blind_index' | 'transport' | 'token';

export const KEY_PURPOSES: readonly KeyPurpose[] = ['field', 'blind_index', 'transport', 'token'];

/** `active` encrypts and decrypts · `rotating` decrypts only · `retired` does neither. */
export type KeyStatus = 'active' | 'rotating' | 'retired';

export const KEY_STATUSES: readonly KeyStatus[] = ['active', 'rotating', 'retired'];

export type KeyAlgorithm = 'AES-256-GCM' | 'HMAC-SHA256' | 'RSA-OAEP-256';

export const KEY_ALGORITHMS: readonly KeyAlgorithm[] = [
  'AES-256-GCM',
  'HMAC-SHA256',
  'RSA-OAEP-256',
];

/**
 * Exact key sizes this build accepts, in bytes.
 *
 * AES-256 is exactly 32 — a shorter buffer is not "a weaker key", `createCipheriv` simply
 * throws, and a longer one is a configuration mistake worth surfacing. HMAC-SHA256 accepts
 * a range: RFC 2104 recommends at least the hash output (32 bytes) and gains nothing above
 * the block size (64), where the key is hashed down anyway.
 */
const KEY_SIZE_RULES: Record<'AES-256-GCM' | 'HMAC-SHA256', { min: number; max: number }> = {
  'AES-256-GCM': { min: 32, max: 32 },
  'HMAC-SHA256': { min: 32, max: 64 },
};

/** A row of `encryption_keys`, as it comes back from Postgres (snake_case). */
interface EncryptionKeyRow {
  kid: string;
  purpose: string;
  algorithm: string;
  key_ref: string;
  status: string;
}

/**
 * A loaded key. `material` never leaves this module — see `describe()` for the safe view.
 *
 * **Do not hold one of these across an `await`.** `load()` zero-fills the buffers of the key
 * set it replaces (see `wipe()`), so a `RegisteredKey` captured before a reload and used after
 * one has an all-zero `material`, and encryption under an all-zero key succeeds silently. The
 * consumers in this module are safe by construction — every one of them calls `getActiveKey()`
 * / `getKeyForDecryption()` and uses the result in the same synchronous block, with no
 * suspension point in between — and every future consumer (T-017's model hooks, T-018's
 * transport layer) must keep that shape. Fetch the key immediately before use; never cache it
 * on a field, in a closure, or across an I/O boundary.
 */
export interface RegisteredKey {
  kid: string;
  purpose: KeyPurpose;
  algorithm: KeyAlgorithm;
  status: KeyStatus;
  material: Buffer;
}

/** Everything about a key that is safe to log, serialise or return from an ops endpoint. */
export interface KeyDescriptor {
  kid: string;
  purpose: KeyPurpose;
  algorithm: KeyAlgorithm;
  status: KeyStatus;
}

@Injectable()
export class KeyRegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KeyRegistryService.name);

  private keysByKid = new Map<string, RegisteredKey>();
  /**
   * Holds the key itself, not its kid. A kid would mean a second lookup that can, in
   * principle, miss — an "impossible" branch that could never be tested and would therefore
   * never be known to work. Storing the resolved key makes the inconsistency unrepresentable.
   */
  private activeByPurpose = new Map<KeyPurpose, RegisteredKey>();
  private loaded = false;

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    @Inject(KEY_MATERIAL_RESOLVERS) private readonly resolvers: readonly KeyMaterialResolver[],
  ) {}

  /** Nest calls this during `app.init()`. A throw here stops the process — intentionally. */
  async onModuleInit(): Promise<void> {
    await this.load();
  }

  /**
   * Wipes resolved key material on shutdown. Buffers are zero-filled rather than merely
   * dropped, so a heap dump taken after `app.close()` does not still contain live keys.
   */
  onModuleDestroy(): void {
    this.wipe();
  }

  /**
   * Reads every row, resolves every pointer, validates the whole set, then swaps it in
   * atomically. Validation happens against local maps so a failed reload leaves the previous
   * (working) key set untouched rather than half-replaced — relevant for a future hot reload,
   * and free to do correctly now.
   *
   * **Every row is attempted before the boot is failed** (T-067). Bailing out on the first bad
   * row made a table with ten broken rows take ten boot-fix-reboot cycles to diagnose, one
   * variable at a time — observed for real on this project's shared development database, where
   * interrupted test runs had accumulated exactly that. Reporting them together changes only
   * *what the operator learns*: the boot still fails, on the same conditions, with no row
   * accepted that would previously have been refused.
   */
  async load(): Promise<void> {
    const rows = await this.sequelize.query<EncryptionKeyRow>(
      `SELECT kid, purpose, algorithm, key_ref, status
         FROM reward_portal.encryption_keys
        ORDER BY id`,
      { type: QueryTypes.SELECT },
    );

    const byKid = new Map<string, RegisteredKey>();
    const activeByPurpose = new Map<KeyPurpose, RegisteredKey>();

    try {
      /** One message per row that could not be loaded. Non-empty here means the boot fails. */
      const rejected: string[] = [];

      for (const row of rows) {
        let key: RegisteredKey;
        try {
          key = await this.loadOne(row);
        } catch (err) {
          // A `KeyRegistryError` is a verdict on *this row* — collect it and keep going, so the
          // operator sees every broken row at once. Anything else is a genuine fault in the
          // resolver or the driver (a KMS timeout, a bug) rather than a statement about
          // configuration, and must not be folded into a "your rows are wrong" report.
          if (!(err instanceof KeyRegistryError)) throw err;
          rejected.push(err.message);
          continue;
        }

        if (byKid.has(key.kid)) {
          // `uq` on kid makes this unreachable through the database, but the registry must not
          // depend on a constraint it does not own for a correctness property this severe.
          throw new KeyRegistryError(`Duplicate kid '${key.kid}' in encryption_keys.`);
        }
        byKid.set(key.kid, key);

        if (key.status === 'active') {
          const existing = activeByPurpose.get(key.purpose);
          if (existing !== undefined) {
            throw new KeyRegistryError(
              `Two active keys for purpose '${key.purpose}' ('${existing.kid}' and ` +
                `'${key.kid}'). Exactly one key per purpose may be active — otherwise which ` +
                `key encrypts is undefined.`,
            );
          }
          activeByPurpose.set(key.purpose, key);
        }
      }

      if (rejected.length > 0) throw new KeyRegistryError(describeRejectedRows(rejected));

      this.assertKeysAreDistinct(byKid);
    } catch (err) {
      // Zero-fill whatever this attempt did manage to resolve before propagating. Without this,
      // a failed load leaves real key material resident in a heap the process is about to dump
      // a stack trace from — the exact leak `wipe()` exists to prevent, on the one path most
      // likely to be running under a debugger.
      for (const key of byKid.values()) key.material.fill(0);
      throw err;
    }

    this.wipe();
    this.keysByKid = byKid;
    this.activeByPurpose = activeByPurpose;
    this.loaded = true;

    // kid and status only. Never key material, never key_ref values (Implementation notes §8).
    this.logger.log(
      `Key registry loaded: ${byKid.size} key(s) — ` +
        (byKid.size === 0
          ? 'none'
          : [...byKid.values()].map((k) => `${k.kid}(${k.purpose}/${k.status})`).join(', ')),
    );
  }

  /** Validates one row and resolves its material. Every failure path stops the boot. */
  private async loadOne(row: EncryptionKeyRow): Promise<RegisteredKey> {
    const kid = row.kid;
    if (!KID_PATTERN.test(kid)) {
      throw new KeyRegistryError(
        `encryption_keys.kid '${kid}' is not a valid key id (expected ${KID_PATTERN}). ` +
          `A kid travels inside every ciphertext and must be safe to embed and to compare.`,
      );
    }
    if (!KEY_PURPOSES.includes(row.purpose as KeyPurpose)) {
      throw new KeyRegistryError(
        `encryption_keys.purpose '${row.purpose}' (kid=${kid}) is not one of ` +
          `${KEY_PURPOSES.join(', ')}.`,
      );
    }
    if (!KEY_STATUSES.includes(row.status as KeyStatus)) {
      throw new KeyRegistryError(
        `encryption_keys.status '${row.status}' (kid=${kid}) is not one of ` +
          `${KEY_STATUSES.join(', ')}.`,
      );
    }
    if (!KEY_ALGORITHMS.includes(row.algorithm as KeyAlgorithm)) {
      throw new KeyRegistryError(
        `encryption_keys.algorithm '${row.algorithm}' (kid=${kid}) is not one of ` +
          `${KEY_ALGORITHMS.join(', ')}.`,
      );
    }

    const purpose = row.purpose as KeyPurpose;
    const algorithm = row.algorithm as KeyAlgorithm;
    const status = row.status as KeyStatus;

    // The purpose/algorithm pairing is not cosmetic: `FieldCryptoService` would otherwise
    // happily feed an HMAC key to AES, and `BlindIndexService` an AES key to HMAC.
    const expected = purpose === 'blind_index' ? 'HMAC-SHA256' : 'AES-256-GCM';
    if (algorithm !== expected) {
      throw new KeyRegistryError(
        `encryption_keys kid=${kid} pairs purpose '${purpose}' with algorithm '${algorithm}'; ` +
          `this build implements '${purpose}' as ${expected} only. ` +
          `(RSA-OAEP-256 has no consumer yet — T-018 owns transport key exchange and uses ` +
          `ECDH P-256, not RSA. Extend this check there rather than loosening it here.)`,
      );
    }

    const ref = parseKeyRef(row.key_ref, kid);
    const resolver = this.resolvers.find((r) => r.scheme === ref.scheme);
    if (resolver === undefined) {
      throw new KeyRegistryError(
        `No key material resolver registered for scheme '${ref.scheme}' (kid=${kid}).`,
      );
    }

    const material = await resolver.resolve(ref, kid);
    const rule = KEY_SIZE_RULES[algorithm as 'AES-256-GCM' | 'HMAC-SHA256'];
    if (material.length < rule.min || material.length > rule.max) {
      // Zero-fill before throwing: this buffer never reaches `load()`'s map, so it would
      // otherwise escape the sweep in the `catch` there and stay resident (T-067).
      material.fill(0);
      // Length only — never the bytes, and never how far off they were beyond this.
      throw new KeyRegistryError(
        `Key material for kid=${kid} is ${material.length} bytes; ${algorithm} requires ` +
          `${rule.min === rule.max ? `exactly ${rule.min}` : `${rule.min}–${rule.max}`} bytes.`,
      );
    }

    return { kid, purpose, algorithm, status, material };
  }

  /**
   * Implementation notes §6 — "The blind-index key must be a different key from the field
   * key. Same-key derivation means compromising one compromises both." Enforced as the
   * stronger, simpler property: **no two keys in the registry may share material at all.**
   * That also catches the copy-paste case where two `kid`s point at the same env var, which
   * would make a "rotation" a no-op that looks like it worked (TC-20).
   */
  private assertKeysAreDistinct(byKid: Map<string, RegisteredKey>): void {
    const keys = [...byKid.values()];
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        if (sameMaterial(keys[i].material, keys[j].material)) {
          throw new KeyRegistryError(
            `Keys '${keys[i].kid}' (${keys[i].purpose}) and '${keys[j].kid}' ` +
              `(${keys[j].purpose}) resolve to identical key material. Every key ring must ` +
              `use distinct material — sharing it means compromising one compromises both ` +
              `(07-DATA-PROTECTION.md §6).`,
          );
        }
      }
    }
  }

  /** True once `load()` has completed successfully at least once. */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * The key new ciphertext is written with. Throws rather than returning `undefined`: a
   * caller that reaches here without an active key must fail, not silently store plaintext.
   */
  getActiveKey(purpose: KeyPurpose): RegisteredKey {
    this.assertLoaded();
    const key = this.activeByPurpose.get(purpose);
    if (key === undefined) {
      throw new KeyRegistryError(
        `No active key for purpose '${purpose}'. Insert an encryption_keys row with ` +
          `status='active' and a key_ref pointing at the key's location.`,
      );
    }
    return key;
  }

  /**
   * The key an existing ciphertext's embedded `kid` names. Accepts `active` and `rotating`
   * (that overlap is what makes rotation zero-downtime — 07-DATA-PROTECTION.md §3) and
   * refuses `retired`, which is the whole point of retiring a key.
   */
  getKeyForDecryption(kid: string): RegisteredKey {
    this.assertLoaded();
    const key = this.keysByKid.get(kid);
    if (key === undefined) throw new DecryptionError('unknown_key', kid);
    if (key.status === 'retired') throw new DecryptionError('retired_key', kid);
    return key;
  }

  /** Metadata for every loaded key. Contains no key material — safe to log or serialise. */
  describe(): KeyDescriptor[] {
    return [...this.keysByKid.values()].map(({ kid, purpose, algorithm, status }) => ({
      kid,
      purpose,
      algorithm,
      status,
    }));
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new KeyRegistryError(
        'Key registry has not been loaded. CryptoModule must be initialised before any ' +
          'encryption or decryption is attempted.',
      );
    }
  }

  /**
   * Zero-fills every held key buffer and drops the maps.
   *
   * The zero-fill is what keeps a heap dump taken after shutdown (or after a rotation reload)
   * from still containing live keys. Its cost is the invariant documented on `RegisteredKey`:
   * any reference handed out before this runs is now a buffer of zeros. That is deliberate —
   * a stale reference producing an obviously-wrong key is recoverable, whereas leaving old key
   * material resident in the heap for the lifetime of the process is not.
   */
  private wipe(): void {
    for (const key of this.keysByKid.values()) key.material.fill(0);
    this.keysByKid = new Map();
    this.activeByPurpose = new Map();
    this.loaded = false;
  }
}

/**
 * Constant-time material comparison. The length check short-circuits (`timingSafeEqual`
 * throws on a length mismatch), which leaks key *length* — irrelevant, since lengths are
 * fixed by the algorithm and this only ever compares our own keys to each other at boot.
 */
function sameMaterial(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Folds every rejected row into the one message the boot failure carries (T-067).
 *
 * A single failure is reported verbatim, unchanged from before this existed — the common case
 * is one genuinely misconfigured key, and wrapping that in a summary would be noise. Only when
 * there is more than one does the count and the "fix every one of them" framing earn its place;
 * an operator who fixes just the first and reboots is back where they started.
 *
 * Every constituent message is already redaction-safe: each is a `KeyRegistryError` raised by
 * `loadOne`, and none of those contain key material, key_ref values or plaintext (see this
 * file's header and `crypto.errors.ts`). Concatenating them adds no new information.
 */
function describeRejectedRows(messages: readonly string[]): string {
  if (messages.length === 1) return messages[0];
  return (
    `${messages.length} encryption_keys rows could not be loaded, and every one of them must ` +
    `be resolved before the portal can start — either make the key material reachable, or ` +
    `delete the row if the key it names is genuinely gone (a row whose key cannot be found ` +
    `protects nothing, but the registry cannot assume that on your behalf):\n` +
    messages.map((message, index) => `  ${index + 1}. ${message}`).join('\n')
  );
}
