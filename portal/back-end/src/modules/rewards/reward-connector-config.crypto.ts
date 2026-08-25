/**
 * T-032 — application-layer field encryption for `reward_config.reward_systems.connector_config`
 * (implementation note 4: *"connector_config may contain third-party credentials ... encrypt at
 * rest (AES-256-GCM, key from env) before writing"*).
 *
 * ### Why this column, when 07-DATA-PROTECTION.md §6 names a different one
 *
 * §6's table lists `reward_versions.connector_config`, not `reward_systems.connector_config`,
 * as the column to encrypt, and `T017_002_seed_policies.ts`'s own seeded row for it — deliberately
 * `at_rest: 'none'`, blocked by `trg_reward_versions_immutable` (T-005) — says nothing about
 * `reward_systems.connector_config` at all, in either direction. This task's own file
 * (T-032-rewards-management.md, implementation note 4) is explicit and unambiguous that *this*
 * column — the one `POST /rewards` actually writes — must be encrypted. That is a genuine gap
 * between the design doc (silent on this specific column) and the task file (explicit about it);
 * resolved in the task file's favour, flagged for the architect in the completion report per
 * AGENT-PROTOCOL §3.
 *
 * It does not conflict with §6's boxed warning ("existing `reward_config` columns are
 * deliberately not encrypted in place ... read today by other services"): that warning is about
 * *pre-existing* rows other running services already consume (`merchants.contact_email` and the
 * like). `reward_systems.tenant_id` was `NOT NULL` until T-002's authorised `DROP NOT NULL`, so
 * no `tenant_id IS NULL` row could exist before this task, and this service only ever reads/
 * writes `tenant_id IS NULL` rows (implementation note 1) — every row this class ever touches is
 * new data this task itself creates, not a pre-existing row some other consumer depends on.
 *
 * ### Why this is a dedicated class, not `model-encryption.hooks.ts`
 *
 * `back-end/src/common/data-protection/**` and `back-end/src/database/migrations/**` are outside
 * this task's `Files owned` (R9) — the generic, policy-table-driven hook mechanism needs a
 * `data_protection_policies` row this task has no migration path to add. `PortalUserEmailCrypto`
 * (T-056, `common/data-protection/portal-user-email.crypto.ts`) already establishes the accepted
 * precedent for exactly this situation: a small, self-contained crypto helper built directly on
 * `FieldCryptoService`, for a column the generic hook mechanism does not (or, per T-017's own
 * note, currently cannot) reach.
 *
 * ### Why the ciphertext is wrapped in `{ __enc: '<envelope>' }`, not written raw
 *
 * `reward-system.model.ts` (T-003, not owned by this task) already declares `connectorConfig` as
 * a typed getter/setter over `parseJsonColumn`/`stringifyJsonColumn` — a JSON-in-`text` column,
 * like every other legacy JSON blob in this schema. Writing the raw ciphertext string directly
 * would either double-JSON-encode it (through the existing setter) or require bypassing the
 * setter with `setDataValue`, a `back-end/src/database/models/**` concern this task may not
 * touch. Wrapping the ciphertext string as the sole value of a one-key object keeps every write
 * fully inside the existing getter/setter's `Record<string, unknown>` contract —
 * `JSON.stringify({ __enc: 'v1.…' })` round-trips through `parseJsonColumn` exactly like any
 * other JSON object — while the stored text still contains **zero plaintext**: TC-10 ("ciphertext
 * in the DB, not plaintext") and verification step 3 ("the raw API key is not readable") are both
 * about the absence of plaintext, not about the column's outer JSON shape.
 *
 * ### Two-phase AAD binding, and why it is safe here (unlike `reward_versions`)
 *
 * `FieldCryptoService` binds the record's identity into the ciphertext as AAD, so a ciphertext
 * copied from row A into row B fails to decrypt (07-DATA-PROTECTION.md §4). `reward_systems.id`
 * is `int generated always as identity`, unknown until after the `INSERT`, so this class follows
 * the same two-phase pattern `PortalUserEmailCrypto`/`model-encryption.hooks.ts` use for
 * `portal_users.email`: encrypt under a provisional AAD, `INSERT`, then re-encrypt under the real
 * id and `UPDATE` — both inside one transaction. `reward_systems` carries no
 * `trg_..._immutable` trigger (unlike `reward_versions`, T005_007's own trigger), so this second
 * `UPDATE` — the exact thing T017_002 documents as blocking `reward_versions.connector_config` —
 * is not blocked here.
 */
import { Injectable } from '@nestjs/common';
import { FieldCryptoService, looksLikeCiphertext, type FieldCryptoOptions } from '@/common/crypto';

/** Schema-qualified table name — the first half of every AAD this class builds. */
export const REWARD_SYSTEMS_TABLE = 'reward_config.reward_systems';

/**
 * Placeholder AAD for a row that does not have its identity column yet — the `INSERT` case.
 * Deliberately distinct from T-017's own `PROVISIONAL_PK`
 * (`common/data-protection/model-encryption.hooks.ts`): this class does not interoperate with
 * that mechanism at all (see the file header), so sharing its constant would only create an
 * accidental coupling between two independent encryption schemes.
 */
export const PROVISIONAL_REWARD_SYSTEM_PK = '#new-reward-system';

/** The sole key of the wrapper object persisted into `connector_config`'s JSON-in-`text` column
 * — see the file header for why the wrapper exists at all. */
const ENVELOPE_KEY = '__enc';

interface ConnectorConfigEnvelope {
  readonly __enc?: unknown;
}

@Injectable()
export class RewardConnectorConfigCrypto {
  constructor(private readonly fieldCrypto: FieldCryptoService) {}

  private static aad(primaryKey: string | number): FieldCryptoOptions {
    return { aad: FieldCryptoService.aadFor(REWARD_SYSTEMS_TABLE, primaryKey) };
  }

  /**
   * Encrypts `config` for a row whose id is not known yet (the `INSERT` case). The caller
   * **must** follow this with {@link rebindToRow} inside the same transaction once the row's
   * real id is known — the value written here is not final.
   */
  encryptForNewRow(config: Record<string, unknown>): Record<string, unknown> {
    const ciphertext = this.fieldCrypto.encrypt(
      JSON.stringify(config),
      RewardConnectorConfigCrypto.aad(PROVISIONAL_REWARD_SYSTEM_PK),
    );
    return { [ENVELOPE_KEY]: ciphertext };
  }

  /** Encrypts `config` for a row whose id is already known (the `UPDATE` case). */
  encryptForRow(id: number, config: Record<string, unknown>): Record<string, unknown> {
    const ciphertext = this.fieldCrypto.encrypt(
      JSON.stringify(config),
      RewardConnectorConfigCrypto.aad(id),
    );
    return { [ENVELOPE_KEY]: ciphertext };
  }

  /**
   * Re-encrypts the provisional envelope under the row's real id. Returns the rebound envelope
   * to persist in the follow-up `UPDATE`.
   */
  rebindToRow(id: number, provisionalStored: Record<string, unknown>): Record<string, unknown> {
    const ciphertext = extractCiphertext(provisionalStored);
    if (ciphertext === null) {
      throw new Error(
        'rebindToRow() called with a value that is not a provisional connector_config envelope ' +
          '— encryptForNewRow() must run first, in the same transaction.',
      );
    }
    const plaintext = this.fieldCrypto.decrypt(
      ciphertext,
      RewardConnectorConfigCrypto.aad(PROVISIONAL_REWARD_SYSTEM_PK),
    );
    return this.encryptForRow(id, JSON.parse(plaintext) as Record<string, unknown>);
  }

  /**
   * Decrypts a stored value read from `connector_config` back into the plaintext object, or
   * `null` when no connector config has ever been set for this row — either the column is
   * genuinely `NULL` (`parseJsonColumn`'s `{}` fallback carries no `__enc` key) or it holds
   * something other than this class's own envelope. The latter is tolerated rather than thrown
   * on, matching this codebase's "one bad row must not break a whole request" rule
   * (`json-text.util.ts`'s own stated discipline) — this service only ever reads `tenant_id IS
   * NULL` rows it wrote itself (see the file header), so in practice this branch is unreachable
   * in normal operation, but a defensive `null` is cheaper than a 500 if it ever is.
   *
   * Returns `null` (rather than throwing `DecryptionError`) on a genuine authentication failure
   * too — a corrupted or tampered ciphertext must not crash a detail read; the caller renders
   * "connector config unavailable" instead of a 500.
   */
  decryptForRow(id: number, stored: Record<string, unknown>): Record<string, unknown> | null {
    const ciphertext = extractCiphertext(stored);
    if (ciphertext === null) return null;
    try {
      const plaintext = this.fieldCrypto.decrypt(ciphertext, RewardConnectorConfigCrypto.aad(id));
      return JSON.parse(plaintext) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function extractCiphertext(stored: Record<string, unknown>): string | null {
  const envelope = stored as ConnectorConfigEnvelope;
  const value = envelope[ENVELOPE_KEY];
  return typeof value === 'string' && looksLikeCiphertext(value) ? value : null;
}
