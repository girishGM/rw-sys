/**
 * T-121 — application-layer field encryption for
 * `reward_config.field_api_lookup_providers.auth_config_enc` (task implementation note 1:
 * *"`auth_config` (`text`, **encrypted at rest** — write `field-api-lookup-config.crypto.ts`
 * following `reward-connector-config.crypto.ts`'s exact pattern, since this column will
 * eventually hold real credentials even though every seeded row today has an empty/placeholder
 * config)"*).
 *
 * Every seeded row today has a NULL config and `auth_type = 'none'` — but this column is where an
 * API key or bearer token *will* live once a data owner confirms one, so it is built to that
 * standard now rather than retrofitted later. Retrofitting encryption onto a column that already
 * holds plaintext in a production database is a data migration plus a key-management problem;
 * building it in while the column is empty costs nothing.
 *
 * ### Why a dedicated class, not `model-encryption.hooks.ts`
 *
 * Same reason `RewardConnectorConfigCrypto` (T-032) and `PortalUserEmailCrypto` (T-056) each give:
 * the generic, policy-table-driven hook mechanism needs a `data_protection_policies` row, and
 * `common/data-protection/**` is outside this task's `Files owned` (R9). A small, self-contained
 * helper built directly on `FieldCryptoService` is the established precedent for exactly this
 * situation.
 *
 * ### Why the ciphertext is stored raw, unlike `RewardConnectorConfigCrypto`'s `{ __enc }` wrapper
 *
 * That wrapper exists for one specific reason its own header spells out: `reward_systems.
 * connector_config` is a *pre-existing* JSON-in-`text` column whose model already declares a typed
 * getter/setter over `parseJsonColumn`/`stringifyJsonColumn`, and writing a bare ciphertext string
 * through that setter would double-encode it. `auth_config_enc` is a brand-new column created by
 * this task's own `T121_001` with no such accessor (see `field-api-lookup-provider.model.ts`),
 * so the envelope would be pure overhead — one more layer to strip, and one more shape a future
 * reader could mistake for "structured data I can read directly". The security-relevant half of
 * the pattern — `FieldCryptoService` + AAD bound to the row's identity — is followed exactly.
 *
 * ### Two-phase AAD binding
 *
 * `FieldCryptoService` binds the record's identity into the ciphertext as AAD, so a ciphertext
 * copied from row A into row B fails to decrypt (07-DATA-PROTECTION.md §4). `id` is `int generated
 * always as identity`, unknown until after the `INSERT`, so this class follows the same two-phase
 * pattern `RewardConnectorConfigCrypto`/`PortalUserEmailCrypto` use: encrypt under a provisional
 * AAD, `INSERT`, then re-encrypt under the real id and `UPDATE`, both inside one transaction.
 * `field_api_lookup_providers` carries no immutability trigger, so the second `UPDATE` is not
 * blocked (contrast `reward_versions`, T017_002).
 *
 * The alternative — binding the AAD to the immutable natural key `provider_code`, which is known
 * before the `INSERT` — was considered and rejected: identity columns are never reused, so an
 * id-bound ciphertext cannot be replayed into a later row that happens to reclaim a deleted
 * `provider_code`. The extra `UPDATE` is worth that property, and it keeps this class consistent
 * with every other field-encryption helper in the codebase.
 */
import { Injectable } from '@nestjs/common';
import { FieldCryptoService, looksLikeCiphertext, type FieldCryptoOptions } from '@/common/crypto';

/** Schema-qualified table name — the first half of every AAD this class builds. */
export const FIELD_API_LOOKUP_PROVIDERS_TABLE = 'reward_config.field_api_lookup_providers';

/**
 * Placeholder AAD for a row that does not have its identity column yet — the `INSERT` case.
 * Deliberately distinct from T-017's `PROVISIONAL_PK` and T-032's own provisional constant: this
 * class does not interoperate with either mechanism, so sharing a constant would only create an
 * accidental coupling between independent encryption schemes.
 */
export const PROVISIONAL_FIELD_API_LOOKUP_PROVIDER_PK = '#new-field-api-lookup-provider';

@Injectable()
export class FieldApiLookupConfigCrypto {
  constructor(private readonly fieldCrypto: FieldCryptoService) {}

  private static aad(primaryKey: string | number): FieldCryptoOptions {
    return { aad: FieldCryptoService.aadFor(FIELD_API_LOOKUP_PROVIDERS_TABLE, primaryKey) };
  }

  /**
   * Encrypts `config` for a row whose id is not known yet (the `INSERT` case). The caller **must**
   * follow this with {@link rebindToRow} inside the same transaction once the row's real id is
   * known — the value written here is not final.
   *
   * `null`/`undefined` in means `null` out: "this provider has no credential", the state every
   * seeded row is in today. That is stored as a genuine SQL NULL, never as an encrypted empty
   * string, so `auth_config_enc IS NULL` remains a meaningful query.
   */
  encryptForNewRow(config: Record<string, unknown> | null | undefined): string | null {
    if (config === null || config === undefined) return null;
    return this.fieldCrypto.encrypt(
      JSON.stringify(config),
      FieldApiLookupConfigCrypto.aad(PROVISIONAL_FIELD_API_LOOKUP_PROVIDER_PK),
    );
  }

  /** Encrypts `config` for a row whose id is already known (the `UPDATE` case). */
  encryptForRow(id: number, config: Record<string, unknown> | null | undefined): string | null {
    if (config === null || config === undefined) return null;
    return this.fieldCrypto.encrypt(JSON.stringify(config), FieldApiLookupConfigCrypto.aad(id));
  }

  /**
   * Re-encrypts the provisional ciphertext under the row's real id. Returns the rebound ciphertext
   * to persist in the follow-up `UPDATE`, or `null` when the row has no config at all (nothing to
   * rebind — not an error, just the common case today).
   */
  rebindToRow(id: number, provisionalStored: string | null): string | null {
    if (provisionalStored === null) return null;
    if (!looksLikeCiphertext(provisionalStored)) {
      throw new Error(
        'rebindToRow() called with a value that is not a provisional auth_config_enc ciphertext ' +
          '— encryptForNewRow() must run first, in the same transaction.',
      );
    }
    const plaintext = this.fieldCrypto.decrypt(
      provisionalStored,
      FieldApiLookupConfigCrypto.aad(PROVISIONAL_FIELD_API_LOOKUP_PROVIDER_PK),
    );
    return this.encryptForRow(id, JSON.parse(plaintext) as Record<string, unknown>);
  }

  /**
   * Decrypts a stored value read from `auth_config_enc` back into the plaintext object, or `null`
   * when no config has ever been set for this row (a genuine SQL NULL, or a value that is not
   * this class's ciphertext at all).
   *
   * Returns `null` rather than throwing on a genuine authentication failure too — a corrupted or
   * tampered ciphertext must not crash the caller with a 500. This matches
   * `RewardConnectorConfigCrypto`'s own stated discipline ("one bad row must not break a whole
   * request"). The caller (T-123) treats `null` as "this provider is not usable" and declines the
   * lookup, which is the safe direction to fail: a tampered credential is never *used*, it is
   * simply unavailable.
   */
  decryptForRow(id: number, stored: string | null): Record<string, unknown> | null {
    if (stored === null || !looksLikeCiphertext(stored)) return null;
    try {
      const plaintext = this.fieldCrypto.decrypt(stored, FieldApiLookupConfigCrypto.aad(id));
      return JSON.parse(plaintext) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
