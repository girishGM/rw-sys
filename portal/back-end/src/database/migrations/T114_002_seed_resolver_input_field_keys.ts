import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-114 — data-only migration populating `resolver_input_field_keys` (`T114_001`) on the 5 rows
 * `T102_002` seeded. `TRACKER_STATE_LOOKUP` is the one day-1 resolver whose parameter fields
 * include a value the resolver itself consumes as *input* to its lookup (which sibling
 * component to read, `RULE_COMP_COMPLETED_001`'s `targetComponentCode` field —
 * `T105_002`) rather than a value compared against what the resolver returns
 * (13-REWARD-MASTER-VALUE-SOURCES.md §2). Every other seeded resolver reads a fact with no
 * Maker-supplied input at all (an event-payload path, a pre-registered aggregate template, a
 * cached profile field, the current timestamp — all fixed at rule-authoring time via
 * `resolver_config`, never per-campaign), so their fields are `[]`.
 *
 * Kept as its own migration, separate from the `ADD COLUMN` DDL — same reasoning `T102_002`'s
 * own header gives for splitting seed data from table creation.
 */
const INPUT_FIELD_KEYS_BY_RESOLVER: ReadonlyArray<{ code: string; keys: readonly string[] }> = [
  { code: 'JSONPATH_PAYLOAD', keys: [] },
  { code: 'TRACKER_STATE_LOOKUP', keys: ['targetComponentCode'] },
  { code: 'AGGREGATE_SQL', keys: [] },
  { code: 'CUSTOMER_PROFILE_API', keys: [] },
  { code: 'SCHEDULE_CONTEXT', keys: [] },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const entry of INPUT_FIELD_KEYS_BY_RESOLVER) {
      await context.query(
        `UPDATE reward_config.rule_resolvers
            SET resolver_input_field_keys = :keys
          WHERE resolver_code = :code;`,
        {
          type: QueryTypes.RAW,
          transaction: t,
          replacements: { code: entry.code, keys: JSON.stringify(entry.keys) },
        },
      );
    }
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** Reverts all 5 rows to the column's pre-seed `NULL` state — `T114_001`'s own `down()` owns
 * dropping the column itself, this migration only owns the data it wrote. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    const codes = INPUT_FIELD_KEYS_BY_RESOLVER.map((entry) => entry.code);
    await context.query(
      `UPDATE reward_config.rule_resolvers
          SET resolver_input_field_keys = NULL
        WHERE resolver_code IN (:codes);`,
      { type: QueryTypes.RAW, transaction: t, replacements: { codes } },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
