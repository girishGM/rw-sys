import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-046 — supports the 72-hour temporary-credential expiry (BACKLOG.md B-01, T-046 implementation
 * note 5).
 *
 * ## No new column
 *
 * `reward_portal.portal_user_credentials.password_expires_at` already exists — `T002_003` created
 * it (01-DATABASE.md §2.2), and `CredentialService.authenticate()` (T-010) already reads it to
 * fold into `mustChangePassword` (that method's own comment names this exact column). This
 * migration does not repeat it. What it adds is the two things that column alone does not give
 * this feature:
 *
 *  1. **A lookup path.** `TemporaryPasswordService`/an eventual admin screen needs "which
 *     credentials are past their temporary-password expiry and were never changed" — a query with
 *     no supporting index today (`password_expires_at` is otherwise unindexed). The partial index
 *     below covers exactly the rows that matter — `WHERE password_expires_at IS NOT NULL` — and
 *     skips the overwhelming majority of rows, which have never had a temporary or expiring
 *     credential at all.
 *  2. **The two `data_protection_policies` rows the task's own Definition of Done names**
 *     ("confirm the two `data_protection_policies` rows exist — without them this feature leaks
 *     the password into the logs, and every other control here becomes irrelevant"). `T017_002`
 *     already seeded one — `dto.CreateUserResponse.temporaryPassword`, covering `POST /users` —
 *     anticipating this task by name (see that file's own row). This migration adds the second,
 *     symmetric row for `POST /users/:id/reset-password`'s response, `dto.ResetPasswordResponse.
 *     temporaryPassword`. **Functionally the two rows are redundant with each other today** —
 *     `policy.service.ts#aliasesFor` resolves every `dto_field` row by its bare field-name leaf
 *     (`temporaryPassword`), not by the DTO name in the key, so either row alone already protects
 *     both routes' `temporaryPassword` field in logs and responses (`strictestOf` merges the two
 *     into one answer when both match, and both carry identical settings here, so there is no
 *     behavioural difference before and after this migration runs). The row is still added,
 *     deliberately: it is the named, auditable record that the reset route's disclosure was
 *     independently classified, not merely swept up by an alias collision nobody decided on
 *     purpose, and it means a future change to only one of the two routes' visibility does not
 *     have to first discover this aliasing quirk before it can be applied safely.
 *
 * `ui_visibility: 'plain'` (not `'reveal_on_demand'`), exactly like the sibling `T017_002` row —
 * `GET /reveal/:policyKey/:recordId` (T-017) discloses a value already sitting in a database
 * column; a temporary password is never persisted anywhere this DTO could read it back from
 * (users.service.ts's own header), so there is no record for that endpoint to look up. `plain`
 * here means "not masked in *this one* response", which is what BACKLOG.md B-01 actually asks
 * for — masking would defeat a screen whose entire purpose is showing the value once.
 *
 * Neither statement touches `reward_config` (R1) or any column already governed by another task.
 */

const NEW_POLICY_KEY = 'dto.ResetPasswordResponse.temporaryPassword';
const INDEX_NAME = 'ix_puc_password_expires_at';

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `CREATE INDEX ${INDEX_NAME}
          ON reward_portal.portal_user_credentials (password_expires_at)
        WHERE password_expires_at IS NOT NULL`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // `to_regclass` guards the same way `T055_001` guards its own policy insert: this migration
    // must still apply cleanly on a database where T-017's table has not landed (or has been
    // rolled back) without failing the whole chain over an optional, additive row.
    await context.query(
      `
      DO $$
      BEGIN
        IF to_regclass('reward_portal.data_protection_policies') IS NOT NULL THEN
          INSERT INTO reward_portal.data_protection_policies
                 (policy_key, scope, classification, in_transit, log_treatment, ui_visibility, note)
          VALUES ('${NEW_POLICY_KEY}', 'dto_field', 'secret', 'payload_encrypt', 'omit', 'plain',
                  'Shown once on screen, admin-initiated reset (BACKLOG.md B-01, T-046). Same ' ||
                  'field-name alias as dto.CreateUserResponse.temporaryPassword (T017_002) -- ' ||
                  'this row documents the reset route''s own classification decision rather than ' ||
                  'relying on that alias collision alone; see T046_001''s own header.')
          ON CONFLICT (policy_key) DO NOTHING;
        END IF;
      END
      $$;
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      DO $$
      BEGIN
        IF to_regclass('reward_portal.data_protection_policies') IS NOT NULL THEN
          DELETE FROM reward_portal.data_protection_policies WHERE policy_key = '${NEW_POLICY_KEY}';
        END IF;
      END
      $$;
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(`DROP INDEX IF EXISTS reward_portal.${INDEX_NAME}`, {
      type: QueryTypes.RAW,
      transaction: t,
    });

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
