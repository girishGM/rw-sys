import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-114 — `reward_config.rule_resolvers.resolver_input_field_keys`: the data a parameter
 * field's response-only `role` (13-REWARD-MASTER-VALUE-SOURCES.md §2, T-114/T-115) is computed
 * from. Nullable `text` holding a JSON array of parameter-field `key` strings — same tolerant
 * text-JSON convention `rule_master.parameters` already uses (`parseJsonColumn`/
 * `stringifyJsonColumn`, `rule-master.model.ts`), default `[]` on parse failure.
 *
 * Additive `ALTER TABLE … ADD COLUMN`, nullable — permitted under `00-ARCHITECTURE.md` §2 (C1),
 * not R1's "no new tables/columns" wording, exactly as `T103_001`'s own header cites C1 as the
 * operative standard for this schema. No `GRANT` needed here — `reward_app` already holds
 * `SELECT, INSERT, UPDATE` on `reward_config.rule_resolvers` from `T102_001`, and this is a new
 * column on an already-granted table, not a new table.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `ALTER TABLE reward_config.rule_resolvers
         ADD COLUMN resolver_input_field_keys text NULL;`,
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
      `ALTER TABLE reward_config.rule_resolvers
         DROP COLUMN IF EXISTS resolver_input_field_keys;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
