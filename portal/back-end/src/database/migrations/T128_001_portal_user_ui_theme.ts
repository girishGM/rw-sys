import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-128 — `reward_portal.portal_users.ui_theme` (13-REWARD-MASTER-VALUE-SOURCES.md §6).
 *
 * Additive and nullable, the same "every existing INSERT keeps working" discipline every prior
 * `portal_users` column addition in this codebase follows (`preferred_locale`/`preferred_timezone`
 * in `T002_002_portal_users.ts`, `email_bidx` in `T056_001`) — `DEFAULT 'light-blue'` means an
 * existing row reads as the default theme without a backfill, and a fixture that still inserts
 * `portal_users` with a narrow column list (several exist across this codebase's e2e suites, per
 * T-056's own completion report) keeps compiling and keeps working unchanged.
 *
 * `reward_portal` is the portal's own schema, not `reward_config` — AGENT-PROTOCOL R1 (no DDL
 * against `reward_config`) does not apply here at all.
 *
 * The `CHECK` constraint is the three-value enum this task's own file specifies, mirrored on the
 * TypeScript side by `UI_THEMES` in `packages/shared/src/user-preferences.schema.ts` and by the
 * `class-validator` `@IsIn(UI_THEMES)` on `UsersController`'s `PATCH /users/me/preferences` body —
 * three independent layers (wire contract, request validation, storage) agreeing on one set of
 * values, the same defence-in-depth this codebase already applies to `ck_portal_users_role`/
 * `ck_portal_users_status` in `T002_002_portal_users.ts`.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `ALTER TABLE reward_portal.portal_users
         ADD COLUMN ui_theme varchar(20) NULL DEFAULT 'light-blue';`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `ALTER TABLE reward_portal.portal_users
         ADD CONSTRAINT ck_portal_users_ui_theme
         CHECK (ui_theme IN ('light-blue', 'yellow-black', 'red-white'));`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `COMMENT ON COLUMN reward_portal.portal_users.ui_theme IS
        'T-128. Self-service UI theme preference, one of light-blue/yellow-black/red-white. Written only through PATCH /users/me/preferences, by the caller for their own row.';`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** Drops the column and its `CHECK` constraint with it. No data to preserve on the way back —
 * a theme preference is disposable UI state, not a record anything else depends on. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(`ALTER TABLE reward_portal.portal_users DROP COLUMN IF EXISTS ui_theme;`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
