import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-161 — clears the stale `password_expires_at` left behind on credential rows that were already
 * caught by the forced-password-change loop before the code fix shipped.
 *
 * ## What was broken
 *
 * `CredentialService.authenticate()` derives `mustChangePassword` as
 * `portal_users.must_change_password || password_expires_at <= now()`, and `AuthService.login`
 * persists that derived value back onto `portal_users`. Until this task,
 * `CredentialRepository.replacePassword()` never cleared `password_expires_at`, so an account that
 * changed its password *after* its temporary-credential deadline had already elapsed kept a
 * permanently-past timestamp: every subsequent login re-derived `mustChangePassword: true` and
 * wrote it straight back, re-raising the forced change the user had just completed and confining
 * the session to `/auth/change-password` forever. The code fix stops new rows entering that state;
 * it cannot help rows already in it, because nothing will ever clear their column.
 *
 * ## Why this predicate, and not "clear everyone's expiry"
 *
 * `password_updated_at > password_expires_at` means: *the password was changed after the deadline
 * it is still flagged against*. That is a positive, narrow signal that the row is stuck — the
 * account has demonstrably already satisfied the forced change, and the surviving timestamp can
 * only re-trigger it. It is the difference between correcting a known-bad state and mass-disarming
 * a security control:
 *
 *  - A credential still inside its 72-hour window (`password_updated_at < password_expires_at`,
 *    the shape both `users.service.ts#insertCredential` and `TemporaryPasswordService
 *    .setCredentialExpiry` write at issuance) is **not** matched. Its forced change is still
 *    legitimately pending and stays armed — including for an account that has never logged in.
 *  - A credential that never had a temporary password at all has `password_expires_at IS NULL` and
 *    is **not** matched.
 *
 * **Deliberately left alone (recorded rather than silently widened):** an account that changed its
 * password *within* the window still carries a future `password_expires_at`, so it is not matched
 * here and will be prompted once more when that deadline passes. That single prompt then clears
 * the column for good via the code fix in `CredentialService.changePassword`. Widening the
 * predicate to catch those rows would mean clearing deadlines that have not yet elapsed, which is
 * indistinguishable — at the SQL level — from disarming the forced change on an account that
 * genuinely never used its temporary password. One redundant prompt is the cheaper error.
 *
 * No `reward_config` DDL, no schema change at all: this is a data correction against one
 * `reward_portal` column (R1).
 */

/**
 * Shared by `up()` and the pre/post counts, so the statement that reports the work and the
 * statement that does it can never drift apart.
 */
const STUCK_ROW_PREDICATE = `
  password_expires_at IS NOT NULL
    AND password_updated_at IS NOT NULL
    AND password_updated_at > password_expires_at
`;

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    const [affected] = await context.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM reward_portal.portal_user_credentials
        WHERE ${STUCK_ROW_PREDICATE}`,
      { type: QueryTypes.SELECT, transaction: t },
    );

    await context.query(
      `UPDATE reward_portal.portal_user_credentials
          SET password_expires_at = NULL,
              updated_at          = now()
        WHERE ${STUCK_ROW_PREDICATE}`,
      { type: QueryTypes.UPDATE, transaction: t },
    );

    // Migrations here are otherwise silent; this one changes user-visible login behaviour for a
    // set of accounts an operator may need to account for afterwards, so it says how many.
    // eslint-disable-next-line no-console -- T-161: the migration CLI has no logger injected, and
    // the count is the only record of how many accounts this data correction touched.
    console.warn(
      `[T161_001] Cleared stuck password_expires_at on ${affected?.count ?? '0'} credential row(s).`,
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * A deliberate, documented no-op.
 *
 * The forward migration destroys the only copy of the timestamps it clears, so a faithful `down()`
 * is impossible — and the values are not worth preserving in a side table, because every row it
 * touches was, by the predicate's own definition, already past its deadline and already satisfied.
 * Restoring them would only re-create the defect on exactly the accounts that were hurt by it.
 *
 * This still satisfies R7's `migrate → rollback → migrate` cycle: rolling back leaves the schema
 * untouched (there is none to revert), and re-running `up()` forward is idempotent — the predicate
 * is driven by a data condition, not a one-time flag, and matches nothing on the second pass
 * because the rows it would match now have `password_expires_at IS NULL`.
 */
export async function down(_: { context: Sequelize }): Promise<void> {
  // eslint-disable-next-line no-console -- T-161: see this function's own comment; an operator
  // rolling back deserves to be told that the data correction is not being undone.
  console.warn(
    '[T161_001] Rollback is a no-op: the cleared password_expires_at values were already ' +
      'past their deadline and are not restorable. See this migration for why.',
  );
  return Promise.resolve();
}
