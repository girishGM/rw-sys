import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes, type Transaction } from 'sequelize';

/**
 * T-118 — `reward_config.reward_systems` gains `category_id` (`NOT NULL`, backfilled) and
 * `sub_category_id` (nullable) — the reward-side identity fields 13-REWARD-MASTER-VALUE-
 * SOURCES.md §1 assigns to `reward_systems`, parallel to `rule_master.sub_category_id`
 * (T-102/T-105). Unlike `rule_master`, which carries only `sub_category_id` and derives its
 * category through the sub-category's own FK, `reward_systems` carries **both** directly (this
 * task's own scope note) — a reward category may legitimately have zero sub-categories at all
 * (T-116's own "Points never needs one" example), so a reward whose category has none still
 * needs somewhere to record its category.
 *
 * ### Order of operations — backfill before `NOT NULL`
 *
 * Same discipline `T056_001` uses for adding a required column to a populated table:
 *
 * 1. Add `category_id` as `NULL` first — every existing row (and every in-flight `INSERT` from
 *    another service reading this same schema right now, 00-ARCHITECTURE.md §2 C1) stays valid.
 * 2. Backfill every existing row to T-116's seeded `UNCATEGORIZED` category, looked up by its
 *    stable `category_code` rather than a hard-coded id — the actual id is a deployment detail
 *    (which row number a fresh `db:migrate` happens to assign it) this migration must not guess.
 * 3. Only then `ALTER COLUMN category_id SET NOT NULL` — by this point every row already has a
 *    value, so the constraint cannot reject anything already there.
 *
 * ### `DEFAULT` on `category_id`, added right after `SET NOT NULL` — not in the task file, and
 * not optional
 *
 * Several other tasks' own fixtures insert directly into `reward_config.reward_systems` with a
 * raw `INSERT` naming only the columns each of those tasks' own scope needed at the time —
 * confirmed live in `back-end/test/performance/submit-and-login-latency.e2e-spec.ts`,
 * `back-end/test/rewards/campaign-usage.e2e-spec.ts`, `back-end/test/campaigns/campaigns.e2e-
 * spec.ts`, `back-end/test/grpc/grpc.e2e-spec.ts`, `back-end/test/campaign-agent/campaign-
 * agent.e2e-spec.ts`, `back-end/test/versions/reward-version-kind.e2e-spec.ts`,
 * `back-end/test/database/t119-reward-version-kind.e2e-spec.ts` and `back-end/test/approvals/
 * approvals.e2e-spec.ts` — none of them, correctly, expected a `category_id` column to exist at
 * the time they were written. R9 forbids this task from editing any of those other tasks' owned
 * files to add one. A `NOT NULL` column with no `DEFAULT` would make every one of those raw
 * `INSERT`s fail outright the moment this migration ran — a real regression this task would
 * otherwise be responsible for causing in files it cannot touch. Giving the column a `DEFAULT`
 * equal to the same `UNCATEGORIZED` id the backfill already uses closes that gap for free: any
 * `INSERT` that does not name `category_id` gets the same safe, correct default a legacy row was
 * backfilled to. This is additive, not a weakening — nothing about the API's own required-field
 * validation (`create-reward.dto.ts`, `categoryId` is mandatory there) changes; this is a
 * database-level safety net for callers this task does not own, not a way to make the field
 * optional through the portal itself.
 *
 * `sub_category_id` gets no backfill and no `DEFAULT` — `NULL` ("no sub-category") is its own
 * correct value for every pre-existing row, exactly as it is for a freshly created reward whose
 * category has none (T-116's own "Points never needs one" scope note applies identically here).
 *
 * Both FKs reference tables `T116_001` already granted `reward_app` `SELECT/INSERT/UPDATE` on —
 * no new `GRANT` needed here (the T-091 lesson only applies to a *newly created* table).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `ALTER TABLE reward_config.reward_systems
         ADD COLUMN category_id int NULL,
         ADD COLUMN sub_category_id int NULL;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    const uncategorizedId = await resolveUncategorizedCategoryId(context, t);

    await context.query(
      `UPDATE reward_config.reward_systems
          SET category_id = :uncategorizedId
        WHERE category_id IS NULL;`,
      { type: QueryTypes.UPDATE, transaction: t, replacements: { uncategorizedId } },
    );

    // `SET DEFAULT` takes a literal, not a bound parameter — `uncategorizedId` is our own query
    // result, never client input, so direct interpolation here is the same safe, established
    // precedent `T056_001` uses for `BLIND_INDEX_HEX_LENGTH` in a column-width DDL clause.
    await context.query(
      `ALTER TABLE reward_config.reward_systems
         ALTER COLUMN category_id SET NOT NULL,
         ALTER COLUMN category_id SET DEFAULT ${String(uncategorizedId)};`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `ALTER TABLE reward_config.reward_systems
         ADD CONSTRAINT fk_rws_category FOREIGN KEY (category_id)
             REFERENCES reward_config.reward_categories (id),
         ADD CONSTRAINT fk_rws_sub_category FOREIGN KEY (sub_category_id)
             REFERENCES reward_config.reward_sub_categories (id);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `CREATE INDEX ix_rws_category_id ON reward_config.reward_systems (category_id);`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_rws_sub_category_id ON reward_config.reward_systems (sub_category_id);`,
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
    // Dropping each column cascades the drop of its own FK/index/DEFAULT with it — the same
    // simplicity `T119_001_reward_version_kind_value_config.ts#down` relies on for its CHECK
    // constraint. Neither column carries data any other table depends on at rollback time in a
    // fresh environment (this task's own scope note).
    await context.query(
      `ALTER TABLE reward_config.reward_systems
         DROP COLUMN IF EXISTS sub_category_id,
         DROP COLUMN IF EXISTS category_id;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * Looked up by `category_code`, never hard-coded — `T116_001`'s own seed is idempotent and
 * environment-independent on the *code*, not on whatever id a fresh `db:migrate` happens to
 * assign it. Throws with an actionable message naming the missing dependency if `T-116` has
 * somehow not run — the same defensive shape `T056_001`'s `assertOnePolicyRowUpdated` uses for an
 * absent seed row it depends on.
 */
async function resolveUncategorizedCategoryId(
  context: Sequelize,
  transaction: Transaction,
): Promise<number> {
  const rows = await context.query<{ id: number }>(
    `SELECT id FROM reward_config.reward_categories
      WHERE tenant_id = 1 AND category_code = 'UNCATEGORIZED'`,
    { type: QueryTypes.SELECT, transaction },
  );
  const [row] = rows;
  if (row === undefined) {
    throw new Error(
      'T118_001 could not find the UNCATEGORIZED reward category T116_001 seeds — T-116 must ' +
        'run before this migration.',
    );
  }
  return row.id;
}
