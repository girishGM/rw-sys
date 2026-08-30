import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-105 — seeds the two new rule categories (`COMPONENT`, `AGGREGATE`) and their sub-categories,
 * needed by the sample rules `T105_002` creates. `TRANSACTION`/`PRODUCT`/`SCHEDULE`/`USER`/
 * `MERCHANT` already exist (confirmed live before writing this: ids 13/14/15/16/21, all
 * `tenant_id=1`) — this migration reuses the existing `SCHEDULE`(15) category for the one
 * schedule-side sub-category rather than creating a duplicate, since `uq_rc_tenant_code
 * (tenant_id, category_code)` would reject a second `SCHEDULE` row outright.
 *
 * `tenant_id=1` matches the existing convention exactly. Confirmed by reading
 * `rules.service.ts#listCategories`/`#listSubCategories` directly: both call
 * `this.scoped.listAll(...)` with **no tenant filter** — `tenant_id` is a `NOT NULL` DB
 * technicality here, not a real per-tenant read scope, so this is not a per-tenant seed that
 * needs repeating for the other 40 tenants in this database.
 *
 * `WHERE NOT EXISTS` guards make both inserts idempotent on a second `db:migrate` run.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `INSERT INTO reward_config.rule_categories (tenant_id, category_code, name, status)
       SELECT 1, v.code, v.name, 'active'
       FROM (VALUES ('COMPONENT','COMPONENT'), ('AGGREGATE','AGGREGATE')) AS v(code, name)
       WHERE NOT EXISTS (
         SELECT 1 FROM reward_config.rule_categories WHERE tenant_id = 1 AND category_code = v.code
       );`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `INSERT INTO reward_config.rule_sub_categories (category_id, sub_category_code, name, status)
       SELECT c.id, v.sub_code, v.sub_name, 'active'
       FROM (VALUES
         ('COMPONENT','COMP_STATUS_CHECK','Sibling Component Status'),
         ('COMPONENT','COMP_DURATION_CHECK','Sibling Component Duration'),
         ('COMPONENT','COMP_COUNT_CHECK','Component Completion Count'),
         ('AGGREGATE','TXN_COUNT_CHECK','Transaction Count Aggregate'),
         ('AGGREGATE','TXN_SUM_CHECK','Transaction Sum Aggregate'),
         ('SCHEDULE','TIME_WINDOW_CHECK','Transaction Time Window')
       ) AS v(cat_code, sub_code, sub_name)
       JOIN reward_config.rule_categories c ON c.category_code = v.cat_code AND c.tenant_id = 1
       WHERE NOT EXISTS (
         SELECT 1 FROM reward_config.rule_sub_categories
         WHERE category_id = c.id AND sub_category_code = v.sub_code
       );`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** Removes only the rows this migration added — the pre-existing `SCHEDULE` category and its
 * `GENERAL` sub-category are never touched, only additionally read via JOIN. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `DELETE FROM reward_config.rule_sub_categories
       WHERE sub_category_code IN (
         'COMP_STATUS_CHECK','COMP_DURATION_CHECK','COMP_COUNT_CHECK',
         'TXN_COUNT_CHECK','TXN_SUM_CHECK','TIME_WINDOW_CHECK'
       );`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `DELETE FROM reward_config.rule_categories
       WHERE tenant_id = 1 AND category_code IN ('COMPONENT','AGGREGATE');`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
