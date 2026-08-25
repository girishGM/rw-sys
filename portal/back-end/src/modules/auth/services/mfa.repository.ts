/**
 * T-055 — the MFA layer's only door to the database.
 *
 * ### Why this file exists, and why it is not `ScopedRepository`
 *
 * The same two arguments `credential.repository.ts` and `session.repository.ts` already make for
 * T-010 and T-011, and they apply unchanged here:
 *
 *  1. **`MfaService` stays a decision-maker.** Which of "consumed", "already used" and "unknown"
 *     a recovery code falls into is a *rule* with an audit consequence attached; the SQL that
 *     distinguishes them is not. Keeping them apart is what lets every branch — including the
 *     ones a real database will not produce on demand — be driven from an in-memory double,
 *     which is what the 100% coverage bar on `src/modules/auth/**` actually requires.
 *  2. **`ScopedRepository` is structurally inapplicable.** These statements run on `@Public()`
 *     routes, before any session and therefore before any `ScopeContext` exists — `require()`
 *     would (correctly) throw. And MFA state is not scoped data: it hangs off `portal_users.id`,
 *     which is already the narrowest possible predicate.
 *
 * So the access is raw, parameterised SQL through the shared `Sequelize` instance — the same
 * convention every migration, `key-registry.service.ts` and both sibling repositories follow, and
 * deliberately **not** `PortalUser.update()`, because T-013's `no-raw-model-access` rule bans
 * model statics outside `src/common/scope/` and `src/database/` and this file must pass it with
 * no `eslint-disable` (R2).
 *
 * **Every caller-supplied value below is a bound replacement.** Nothing is spliced into SQL text.
 *
 * This file is an addition to T-055's declared *Files owned* list, mirroring the precedent T-010
 * and T-011 set. Recorded as a deviation in the completion report.
 */
import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import type { PortalRole } from '@/database/portal-models';
import type { AuthTransaction } from './credential.repository';

/**
 * The MFA-relevant projection of `portal_users`.
 *
 * `secretEnc` is the **ciphertext** as stored — this layer never decrypts, because a repository
 * that returned plaintext seeds would make "where can the seed be read?" a question about every
 * caller instead of about one service (`MfaService`, which holds the only `FieldCryptoService`
 * reference in this module).
 */
export interface MfaUserRow {
  readonly id: number;
  readonly email: string;
  readonly displayName: string;
  readonly role: PortalRole;
  readonly status: string;
  /**
   * The scope triple, carried so a completed challenge can mint a session from **this** read
   * rather than from a second one. Two reads would open a window in which a user's scope changed
   * between them, and the session would be issued with claims that match neither.
   */
  readonly countryId: number | null;
  readonly tenantId: number | null;
  readonly merchantId: number | null;
  readonly mustChangePassword: boolean;
  readonly mfaEnabled: boolean;
  readonly secretEnc: string | null;
}

/**
 * The outcome of presenting a recovery code.
 *
 * Three states, not two, because 01-DATABASE.md §2.5a's "never deleted, so a re-use attempt is
 * detectable and auditable rather than merely rejected" only means something if the code that
 * rejects can tell "already spent" from "never existed" (TC-12). The *client* is told the same
 * thing either way; the audit log is not.
 */
export type RecoveryCodeOutcome = 'consumed' | 'already_used' | 'unknown';

export interface MfaStore {
  findUserForMfa(userId: number, tx?: AuthTransaction): Promise<MfaUserRow | null>;
  /** `portal_users.mfa_enabled`, read live for the guard. `null` when the user does not exist. */
  isMfaEnabled(userId: number): Promise<boolean | null>;
  /** Writes the encrypted seed. Does **not** enable MFA — enrolment is confirmed by a code. */
  storeSecret(userId: number, secretEnc: string, tx?: AuthTransaction): Promise<void>;
  /** Flips `mfa_enabled` to true. Called only after a correct code has been presented. */
  enableMfa(userId: number, tx?: AuthTransaction): Promise<void>;
  /** Clears both `mfa_enabled` and `mfa_secret_enc` — the administrative reset (note 6). */
  clearMfa(userId: number, tx?: AuthTransaction): Promise<void>;
  insertRecoveryCodes(
    userId: number,
    codeHashes: readonly string[],
    tx?: AuthTransaction,
  ): Promise<void>;
  /**
   * Marks every still-unused code as used. Used on re-enrolment and on administrative reset, so a
   * code from a previous enrolment can never open an account whose factor has been replaced.
   */
  invalidateRecoveryCodes(userId: number, at: Date, tx?: AuthTransaction): Promise<number>;
  consumeRecoveryCode(
    userId: number,
    codeHash: string,
    at: Date,
    tx?: AuthTransaction,
  ): Promise<RecoveryCodeOutcome>;
  countUnusedRecoveryCodes(userId: number, tx?: AuthTransaction): Promise<number>;
}

/** DI token — every consumer depends on {@link MfaStore}, never on the class below. */
export const MFA_STORE = Symbol('MFA_STORE');

interface RawMfaUserRow {
  id: number;
  email: string;
  display_name: string;
  role: PortalRole;
  status: string;
  country_id: number | null;
  tenant_id: number | null;
  merchant_id: number | null;
  must_change_password: boolean;
  mfa_enabled: boolean;
  mfa_secret_enc: string | null;
}

@Injectable()
export class MfaRepository implements MfaStore {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    /** T-056 — see `credential.repository.ts`'s constructor for why this is here. */
    private readonly emailCrypto: PortalUserEmailCrypto,
  ) {}

  /**
   * `deleted_at IS NULL` is not optional: raw SQL gets none of Sequelize's paranoid filtering, so
   * this predicate *is* the soft-delete control — the same statement `session.repository.ts`
   * makes about `findUserById`.
   */
  async findUserForMfa(userId: number, tx?: AuthTransaction): Promise<MfaUserRow | null> {
    const rows = await this.sequelize.query<RawMfaUserRow>(
      `
      SELECT id, email, display_name, role, status,
             country_id, tenant_id, merchant_id,
             must_change_password, mfa_enabled, mfa_secret_enc
        FROM reward_portal.portal_users
       WHERE id = :userId AND deleted_at IS NULL
       LIMIT 1
      `,
      { type: QueryTypes.SELECT, transaction: tx, replacements: { userId } },
    );

    const row = rows[0];
    if (row === undefined) return null;

    return {
      id: row.id,
      // T-056: ciphertext at rest, raw SQL, no `afterFind` hook. `MfaService` uses this as the
      // account label inside the TOTP `otpauth://` URI, so an undecrypted envelope here would be
      // rendered into the user's authenticator app QR code.
      email: this.emailCrypto.decryptForRow(row.id, row.email),
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      countryId: row.country_id,
      tenantId: row.tenant_id,
      merchantId: row.merchant_id,
      mustChangePassword: row.must_change_password,
      mfaEnabled: row.mfa_enabled,
      secretEnc: row.mfa_secret_enc,
    };
  }

  async isMfaEnabled(userId: number): Promise<boolean | null> {
    const rows = await this.sequelize.query<{ mfa_enabled: boolean }>(
      `
      SELECT mfa_enabled
        FROM reward_portal.portal_users
       WHERE id = :userId AND deleted_at IS NULL
       LIMIT 1
      `,
      { type: QueryTypes.SELECT, replacements: { userId } },
    );

    const row = rows[0];
    return row === undefined ? null : row.mfa_enabled;
  }

  async storeSecret(userId: number, secretEnc: string, tx?: AuthTransaction): Promise<void> {
    await this.sequelize.query(
      `
      UPDATE reward_portal.portal_users
         SET mfa_secret_enc = :secretEnc, updated_at = now()
       WHERE id = :userId AND deleted_at IS NULL
      `,
      { type: QueryTypes.UPDATE, transaction: tx, replacements: { userId, secretEnc } },
    );
  }

  async enableMfa(userId: number, tx?: AuthTransaction): Promise<void> {
    await this.sequelize.query(
      `
      UPDATE reward_portal.portal_users
         SET mfa_enabled = true, updated_at = now()
       WHERE id = :userId AND deleted_at IS NULL
      `,
      { type: QueryTypes.UPDATE, transaction: tx, replacements: { userId } },
    );
  }

  /**
   * The seed is set to NULL as well as the flag being cleared.
   *
   * Leaving the old ciphertext behind would mean a reset account could be re-enabled by flipping
   * one boolean — with a factor its owner has already lost the device for. Re-enrolment mints a
   * fresh seed, which is the only state in which "MFA is on" is true again.
   */
  async clearMfa(userId: number, tx?: AuthTransaction): Promise<void> {
    await this.sequelize.query(
      `
      UPDATE reward_portal.portal_users
         SET mfa_enabled = false, mfa_secret_enc = NULL, updated_at = now()
       WHERE id = :userId AND deleted_at IS NULL
      `,
      { type: QueryTypes.UPDATE, transaction: tx, replacements: { userId } },
    );
  }

  /**
   * Inserts the ten digests in one statement.
   *
   * One round trip and one bound value, with no string building anywhere near the statement. The
   * digests travel as a **JSON array in a single replacement**, expanded server-side by
   * `json_array_elements_text`, for the reason `credential.repository.ts` and
   * `session.repository.ts` both document about arrays: Sequelize expands a JS array inside a
   * replacement into a comma-separated list, which is valid SQL in some positions and a syntax
   * error in others — `CAST('a','b' AS varchar[])` being the second kind. Found by running this
   * against the real database (the e2e suite), not by reading it.
   */
  async insertRecoveryCodes(
    userId: number,
    codeHashes: readonly string[],
    tx?: AuthTransaction,
  ): Promise<void> {
    if (codeHashes.length === 0) return;

    await this.sequelize.query(
      `
      INSERT INTO reward_portal.portal_mfa_recovery_codes (user_id, code_hash)
      SELECT :userId, hash
        FROM json_array_elements_text(CAST(:codeHashes AS json)) AS hash
      `,
      {
        type: QueryTypes.INSERT,
        transaction: tx,
        replacements: { userId, codeHashes: JSON.stringify([...codeHashes]) },
      },
    );
  }

  async invalidateRecoveryCodes(userId: number, at: Date, tx?: AuthTransaction): Promise<number> {
    const [, affected] = await this.sequelize.query(
      `
      UPDATE reward_portal.portal_mfa_recovery_codes
         SET used_at = :at
       WHERE user_id = :userId AND used_at IS NULL
      `,
      { type: QueryTypes.UPDATE, transaction: tx, replacements: { userId, at } },
    );

    return affected;
  }

  /**
   * Consumes one code, and distinguishes the three outcomes in **one round trip**.
   *
   * The `used_at IS NULL` predicate in the UPDATE is what makes consumption atomic: two
   * simultaneous presentations of the same code both reach this statement, Postgres serialises
   * them on the row, and exactly one updates a row. The loser gets zero rows and falls through to
   * the existence check, which reports `already_used` — i.e. the race resolves as a reuse
   * attempt, which is exactly what it is.
   *
   * The code is looked up by `user_id` **and** hash, never by hash alone. `uq_pmrc_hash` makes
   * the hash globally unique, so the extra predicate changes no result — but it means a bug that
   * mixed up two users' codes would fail closed rather than open, and that is worth one column in
   * a WHERE clause.
   */
  async consumeRecoveryCode(
    userId: number,
    codeHash: string,
    at: Date,
    tx?: AuthTransaction,
  ): Promise<RecoveryCodeOutcome> {
    const updated = await this.sequelize.query<{ id: number }>(
      `
      UPDATE reward_portal.portal_mfa_recovery_codes
         SET used_at = :at
       WHERE user_id = :userId AND code_hash = :codeHash AND used_at IS NULL
      RETURNING id
      `,
      { type: QueryTypes.SELECT, transaction: tx, replacements: { userId, codeHash, at } },
    );

    if (updated.length > 0) return 'consumed';

    const existing = await this.sequelize.query<{ id: number }>(
      `
      SELECT id
        FROM reward_portal.portal_mfa_recovery_codes
       WHERE user_id = :userId AND code_hash = :codeHash
       LIMIT 1
      `,
      { type: QueryTypes.SELECT, transaction: tx, replacements: { userId, codeHash } },
    );

    return existing.length > 0 ? 'already_used' : 'unknown';
  }

  async countUnusedRecoveryCodes(userId: number, tx?: AuthTransaction): Promise<number> {
    const rows = await this.sequelize.query<{ remaining: string }>(
      `
      SELECT count(*)::text AS remaining
        FROM reward_portal.portal_mfa_recovery_codes
       WHERE user_id = :userId AND used_at IS NULL
      `,
      { type: QueryTypes.SELECT, transaction: tx, replacements: { userId } },
    );

    // `count(*)` comes back from `pg` as a string (bigint), cast to text here so the conversion is
    // explicit rather than dependent on a driver's parser setting.
    return Number.parseInt(rows[0].remaining, 10);
  }
}
