import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * The two authorised, non-additive `reward_config` changes — C2 of 00-ARCHITECTURE.md §2,
 * verbatim from 01-DATABASE.md §4. **This is the only migration in the whole project
 * allowed to touch `reward_config`.** Both are backward-compatible: existing rows are
 * untouched, and every existing INSERT that supplies a `tenant_id` still succeeds.
 *
 * `tenant_id IS NULL` after this migration means: a global rule/reward, owned by Super
 * Admin, offered to countries via `*_country_assignments`. Only `super_admin` may write
 * such a row (enforced at the service layer, not the database — 00-ARCHITECTURE.md §5.2).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      'ALTER TABLE reward_config.rule_master ALTER COLUMN tenant_id DROP NOT NULL;',
      {
        type: QueryTypes.RAW,
        transaction: t,
      },
    );
    await context.query(
      'ALTER TABLE reward_config.reward_systems ALTER COLUMN tenant_id DROP NOT NULL;',
      { type: QueryTypes.RAW, transaction: t },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * Safe only while no global (`tenant_id IS NULL`) rows exist. Asserts this first and
 * aborts with a clear error rather than failing mid-`ALTER` with a confusing Postgres
 * constraint-violation message — re-adding `NOT NULL` over existing NULL rows would fail
 * anyway, but this gives the operator a legible reason and the exact table to look at.
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const [ruleGlobalRows] = await context.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM reward_config.rule_master WHERE tenant_id IS NULL;',
    { type: QueryTypes.SELECT },
  );
  const [rewardGlobalRows] = await context.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM reward_config.reward_systems WHERE tenant_id IS NULL;',
    { type: QueryTypes.SELECT },
  );

  if (Number(ruleGlobalRows.count) > 0) {
    throw new Error(
      `Cannot roll back T002_009: ${ruleGlobalRows.count} row(s) in reward_config.rule_master ` +
        `have tenant_id IS NULL (global rules). Re-tenant or remove them before rolling back.`,
    );
  }
  if (Number(rewardGlobalRows.count) > 0) {
    throw new Error(
      `Cannot roll back T002_009: ${rewardGlobalRows.count} row(s) in reward_config.reward_systems ` +
        `have tenant_id IS NULL (global rewards). Re-tenant or remove them before rolling back.`,
    );
  }

  const t = await context.transaction();
  try {
    await context.query(
      'ALTER TABLE reward_config.rule_master ALTER COLUMN tenant_id SET NOT NULL;',
      {
        type: QueryTypes.RAW,
        transaction: t,
      },
    );
    await context.query(
      'ALTER TABLE reward_config.reward_systems ALTER COLUMN tenant_id SET NOT NULL;',
      { type: QueryTypes.RAW, transaction: t },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
