import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-173 — extends `fn_reward_version_immutable()` again (created by `T005_007`, last extended by
 * `T119_002`) so that a published version's `expiry_value`/`expiry_unit` are frozen alongside
 * `reward_kind`/`value_config`. This file deliberately reuses `T119_002`'s mechanics verbatim
 * rather than inventing a second approach; that file's header states the reasoning in full.
 *
 * ### Why the expiry duration belongs in the frozen set
 *
 * The expiry duration is a **promise already made to a customer**. A v1 that said "15 days" and is
 * silently rewritten to "15 minutes" retroactively shortens every reward already granted under it —
 * and the runtime that computes `expires_at` (`T-RR-063`) reads the version, not a history of it.
 * Shortening or removing an expiry must therefore be a *new version*, which is the same argument
 * `T119_002` makes for the payout value and `11-BUDGETS-AND-LIMITS.md` §3.1 makes for the payout
 * unit. TC-6 proves it at the database rather than in a service, because that is the only place it
 * holds for a direct `UPDATE` that never passes through this portal's API (06-VERSIONING.md §4.2).
 *
 * `CREATE OR REPLACE FUNCTION`, never an edit to `T005_007`/`T119_002` in place: both belong to
 * already-`done` tasks (R9), and Umzug never re-runs an applied migration's `up()`. The
 * `CREATE TRIGGER ... EXECUTE FUNCTION fn_reward_version_immutable()` from `T005_007` needs no
 * change — replacing the body a trigger already points at takes effect immediately.
 *
 * `down()` restores `T119_002`'s ten-column body verbatim (**not** `T005_007`'s eight-column one),
 * so rolling this task back leaves `reward_kind`/`value_config` protected exactly as T-119 left
 * them. Restoring the wrong ancestor would silently un-freeze another task's columns.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `
    CREATE OR REPLACE FUNCTION reward_config.fn_reward_version_immutable() RETURNS trigger AS $$
    BEGIN
      IF OLD.status <> 'draft' AND (
           NEW.connector_config  IS DISTINCT FROM OLD.connector_config  OR
           NEW.delivery_mode     IS DISTINCT FROM OLD.delivery_mode     OR
           NEW.retry_config      IS DISTINCT FROM OLD.retry_config      OR
           NEW.policies_snapshot IS DISTINCT FROM OLD.policies_snapshot OR
           NEW.unit_type         IS DISTINCT FROM OLD.unit_type         OR
           NEW.unit_code         IS DISTINCT FROM OLD.unit_code         OR
           NEW.version_no        IS DISTINCT FROM OLD.version_no        OR
           NEW.is_breaking       IS DISTINCT FROM OLD.is_breaking       OR
           NEW.reward_kind       IS DISTINCT FROM OLD.reward_kind       OR
           NEW.value_config      IS DISTINCT FROM OLD.value_config      OR
           NEW.expiry_value      IS DISTINCT FROM OLD.expiry_value      OR
           NEW.expiry_unit       IS DISTINCT FROM OLD.expiry_unit) THEN
        RAISE EXCEPTION 'reward_versions.% is published and immutable', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    `,
    { type: QueryTypes.RAW },
  );
}

/** Restores T119_002's ten-column body verbatim — see this file's header for why that one and
 * not T005_007's. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `
    CREATE OR REPLACE FUNCTION reward_config.fn_reward_version_immutable() RETURNS trigger AS $$
    BEGIN
      IF OLD.status <> 'draft' AND (
           NEW.connector_config  IS DISTINCT FROM OLD.connector_config  OR
           NEW.delivery_mode     IS DISTINCT FROM OLD.delivery_mode     OR
           NEW.retry_config      IS DISTINCT FROM OLD.retry_config      OR
           NEW.policies_snapshot IS DISTINCT FROM OLD.policies_snapshot OR
           NEW.unit_type         IS DISTINCT FROM OLD.unit_type         OR
           NEW.unit_code         IS DISTINCT FROM OLD.unit_code         OR
           NEW.version_no        IS DISTINCT FROM OLD.version_no        OR
           NEW.is_breaking       IS DISTINCT FROM OLD.is_breaking       OR
           NEW.reward_kind       IS DISTINCT FROM OLD.reward_kind       OR
           NEW.value_config      IS DISTINCT FROM OLD.value_config) THEN
        RAISE EXCEPTION 'reward_versions.% is published and immutable', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    `,
    { type: QueryTypes.RAW },
  );
}
