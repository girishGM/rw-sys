import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_portal.portal_mfa_recovery_codes` — 01-DATABASE.md §2.5a, column for column, plus the
 * two catalogue rows the feature needs to be complete.
 *
 * ### The table
 *
 * Ten single-use codes per enrolment, shown once, stored only as SHA-256 digests. Two properties
 * of the DDL below carry the whole design:
 *
 *  - **`used_at`, not a delete.** §2.5a: *"each is single-use (`used_at` set on consumption,
 *    never deleted, so a re-use attempt is detectable and auditable rather than merely
 *    rejected)"*. A row that vanished on consumption would make a second presentation of the same
 *    code indistinguishable from a wrong guess — and the difference between those two is the
 *    difference between "somebody typo'd" and "somebody else is holding the printed list"
 *    (T-055 TC-12).
 *  - **`on delete cascade`.** Recovery codes are meaningless without the user they belong to, and
 *    §2.5a specifies the cascade. It is also the reason no other table references this one.
 *
 * `uq_pmrc_hash` is global rather than per-user, exactly as §2.5a writes it. Two users drawing
 * the same 60-bit code is not a scenario worth designing around, and a global constraint means an
 * insert that would create the ambiguity fails loudly instead of creating two rows one lookup
 * could match.
 *
 * ### Why two seeds ride along in this migration
 *
 * Both are configuration the feature cannot work correctly without, and neither belongs to a task
 * that is still open:
 *
 *  1. **A `data_protection_policies` row for `code_hash`** — T-055 implementation note 8:
 *     *"Backup codes and the TOTP secret are `log_treatment: omit` in the data-protection policy
 *     table (T-017), exactly like a password."* T-017 already seeds the row for
 *     `portal_users.mfa_secret_enc` (it could: that column existed); it could not seed one for a
 *     table that did not exist yet. The insert is guarded by a `to_regclass` check so this
 *     migration still applies cleanly on a database where T-017's table is absent.
 *  2. **Two `system_messages` rows** — the codes `MFA_ENROLMENT_REQUIRED` and
 *     `MFA_ALREADY_ENROLLED` that this feature can return. A missing key degrades to the key
 *     itself rather than failing (`message.service.ts`), so this is wording rather than
 *     correctness — but shipping an endpoint whose error the SPA renders as a shouty constant is
 *     not shipping it.
 *
 * Grants: `T002_008_grants.ts` set `ALTER DEFAULT PRIVILEGES IN SCHEMA reward_portal GRANT ALL ON
 * TABLES TO reward_app`, and this migration runs as the same privileged role, so `reward_app`
 * picks the table up automatically. Nothing to grant here.
 */

/** The two catalogue keys this migration owns, in both directions. */
const MESSAGES: readonly { key: string; text: string }[] = Object.freeze([
  {
    key: 'MFA_ENROLMENT_REQUIRED',
    text: 'Set up two-factor authentication to continue.',
  },
  {
    key: 'MFA_ALREADY_ENROLLED',
    text: 'Two-factor authentication is already set up for this account. Ask another Super Admin to reset it if you have lost your device.',
  },
]);

const POLICY_KEY = 'reward_portal.portal_mfa_recovery_codes.code_hash';

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_portal.portal_mfa_recovery_codes (
          id          int generated always as identity primary key,
          user_id     int          not null
                      references reward_portal.portal_users(id) on delete cascade,
          -- SHA-256 of a single-use recovery code; the raw value is shown once at enrolment and
          -- never stored. 64 hex characters today; the column is wider so a future digest change
          -- is not also a schema change.
          code_hash   varchar(128) not null,
          used_at     timestamptz  null,
          created_at  timestamptz  not null default now(),

          constraint uq_pmrc_hash unique (code_hash)
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    // The only query this table serves on the hot path is "this user's unused codes" — the
    // consume statement and the remaining-count. Partial, because a spent code is never looked up
    // by user again, only by hash (which `uq_pmrc_hash` already indexes).
    await context.query(
      `CREATE INDEX ix_pmrc_user_unused ON reward_portal.portal_mfa_recovery_codes(user_id)
        WHERE used_at IS NULL;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // Implementation note 8. Guarded, so this migration does not depend on T-017 having been
    // applied — `to_regclass` returns NULL rather than raising for an absent table.
    await context.query(
      `
      DO $$
      BEGIN
        IF to_regclass('reward_portal.data_protection_policies') IS NOT NULL THEN
          INSERT INTO reward_portal.data_protection_policies
                 (policy_key, scope, classification, log_treatment, ui_visibility, note)
          VALUES ('${POLICY_KEY}', 'column', 'secret', 'omit', 'never',
                  'MFA recovery code digest (T-055). Never logged, never returned.')
          ON CONFLICT (policy_key) DO NOTHING;
        END IF;
      END
      $$;
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    for (const message of MESSAGES) {
      await context.query(
        `INSERT INTO reward_config.system_messages (message_key, message_text)
         VALUES (:key, :text)
         ON CONFLICT (message_key) DO NOTHING;`,
        { type: QueryTypes.INSERT, transaction: t, replacements: message },
      );
    }

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * Drops the table (and with it the index), the policy row and the two messages.
 *
 * **This destroys recovery codes.** Any `super_admin` who has enrolled keeps their TOTP seed —
 * `portal_users.mfa_secret_enc` is not touched here, which is what T-055's Rollback section means
 * by *"left in place (harmless if unused) rather than dropped, so re-enabling later needs no
 * re-enrolment"* — but the printed codes they hold stop being redeemable, because the rows they
 * are checked against are gone. Re-applying this migration creates an empty table, not the old
 * one; the way back is a fresh enrolment, or an administrative reset.
 *
 * `DELETE` rather than `DROP` for the two catalogue rows, and matched by key, so a row somebody
 * has since edited through the portal is removed rather than a whole table being disturbed.
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(`DROP TABLE IF EXISTS reward_portal.portal_mfa_recovery_codes CASCADE;`, {
      type: QueryTypes.RAW,
      transaction: t,
    });

    await context.query(
      `
      DO $$
      BEGIN
        IF to_regclass('reward_portal.data_protection_policies') IS NOT NULL THEN
          DELETE FROM reward_portal.data_protection_policies WHERE policy_key = '${POLICY_KEY}';
        END IF;
      END
      $$;
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    for (const message of MESSAGES) {
      await context.query(`DELETE FROM reward_config.system_messages WHERE message_key = :key;`, {
        type: QueryTypes.DELETE,
        transaction: t,
        replacements: { key: message.key },
      });
    }

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
