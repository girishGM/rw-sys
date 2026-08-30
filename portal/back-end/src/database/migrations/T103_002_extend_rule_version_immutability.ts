import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-103 — extends `fn_rule_version_immutable()` (created by `T005_007`) to also freeze the four
 * resolver-wiring columns `T103_001` just added: `resolver_id`, `resolver_config`,
 * `evaluation_context`, `default_operators`. Without this, a published `rule_versions` row would
 * remain immutable for `expression`/`parameters`/`version_no`/`is_breaking` but freely mutable for
 * its resolver wiring — silently defeating the entire reason (`rule-engine-mapped-design.md`
 * §1.1) these columns were put on `rule_versions` rather than `rule_master` in the first place.
 *
 * `CREATE OR REPLACE FUNCTION`, never an edit to `T005_007_immutability_triggers.ts` in place:
 * that file belongs to an already-`done` task (R9), and Umzug never re-runs an applied
 * migration's `up()` on an already-migrated database (same reasoning `T091_001`'s own header
 * gives for why it added a new migration rather than editing `T002_008`/`T005_00x` — see that
 * file's header for the full argument). The existing `CREATE TRIGGER ... EXECUTE FUNCTION
 * fn_rule_version_immutable()` from `T005_007` needs no change at all: replacing the function
 * body a trigger already points to takes effect immediately.
 *
 * `down()` restores the original four-column T005_007 body verbatim — not just `DROP FUNCTION`,
 * since the trigger must keep protecting `expression`/`parameters`/`version_no`/`is_breaking`
 * after this migration is rolled back, exactly as it did before this task ever ran.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `
    CREATE OR REPLACE FUNCTION reward_config.fn_rule_version_immutable() RETURNS trigger AS $$
    BEGIN
      IF OLD.status <> 'draft' AND (
           NEW.expression          IS DISTINCT FROM OLD.expression          OR
           NEW.parameters          IS DISTINCT FROM OLD.parameters          OR
           NEW.version_no          IS DISTINCT FROM OLD.version_no          OR
           NEW.is_breaking         IS DISTINCT FROM OLD.is_breaking         OR
           NEW.resolver_id         IS DISTINCT FROM OLD.resolver_id         OR
           NEW.resolver_config     IS DISTINCT FROM OLD.resolver_config     OR
           NEW.evaluation_context  IS DISTINCT FROM OLD.evaluation_context  OR
           NEW.default_operators   IS DISTINCT FROM OLD.default_operators) THEN
        RAISE EXCEPTION 'rule_versions.% is published and immutable', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    `,
    { type: QueryTypes.RAW },
  );
}

/** Restores T005_007's original four-column body verbatim. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `
    CREATE OR REPLACE FUNCTION reward_config.fn_rule_version_immutable() RETURNS trigger AS $$
    BEGIN
      IF OLD.status <> 'draft' AND (
           NEW.expression   IS DISTINCT FROM OLD.expression   OR
           NEW.parameters   IS DISTINCT FROM OLD.parameters   OR
           NEW.version_no   IS DISTINCT FROM OLD.version_no   OR
           NEW.is_breaking  IS DISTINCT FROM OLD.is_breaking) THEN
        RAISE EXCEPTION 'rule_versions.% is published and immutable', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    `,
    { type: QueryTypes.RAW },
  );
}
