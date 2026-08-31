import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-119 — extends `fn_reward_version_immutable()` (created by `T005_007`) to also freeze the two
 * columns `T119_001` just added: `reward_kind` and `value_config`. The reward-side mirror of what
 * `T103_002` did to `fn_rule_version_immutable()`; that file's header states the reasoning in
 * full and this one deliberately reuses its mechanics rather than inventing a second approach.
 *
 * Without this, a published `reward_versions` row would stay immutable for
 * `connector_config`/`delivery_mode`/`retry_config`/`policies_snapshot`/`unit_type`/`unit_code`
 * but be freely mutable for the Kind and the amount it pays out — the two columns a budget and an
 * audit trail care about most (11-BUDGETS-AND-LIMITS.md §3.1's "no conversion rate anywhere in
 * the design" argument for freezing the payout unit applies at least as strongly to the payout
 * *value*). TC-6 proves it at the database, not in the service, because that is the only place it
 * holds for a direct `UPDATE` that never passes through this portal's API (06-VERSIONING.md §4.2).
 *
 * `CREATE OR REPLACE FUNCTION`, never an edit to `T005_007_immutability_triggers.ts` in place:
 * that file belongs to an already-`done` task (R9), and Umzug never re-runs an applied
 * migration's `up()`. The `CREATE TRIGGER ... EXECUTE FUNCTION fn_reward_version_immutable()`
 * from `T005_007` needs no change — replacing the body a trigger already points at takes effect
 * immediately.
 *
 * `down()` restores T005_007's original eight-column body verbatim rather than dropping the
 * function, so the trigger keeps protecting everything it protected before this task ever ran.
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

/** Restores T005_007's original eight-column body verbatim. */
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
           NEW.is_breaking       IS DISTINCT FROM OLD.is_breaking) THEN
        RAISE EXCEPTION 'reward_versions.% is published and immutable', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    `,
    { type: QueryTypes.RAW },
  );
}
