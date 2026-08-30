import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-127 — seeds the `VOUCHER` reward category and its `PROMO_CODE` sub-category
 * (`13-REWARD-MASTER-VALUE-SOURCES.md` §5, task implementation note 1).
 *
 * **`VOUCHER` is created here, not assumed.** Checked live before writing this: `T116_001` seeds
 * exactly one row (`UNCATEGORIZED`) and `T105_001`'s categories are the *rule* side, a different
 * pair of tables — so nothing upstream has ever created a reward `VOUCHER` category. The insert is
 * still written `WHERE NOT EXISTS` rather than as a bare `INSERT`, for the same reason `T105_001`
 * is: `uq_rwc_tenant_code (tenant_id, category_code)` would make a second `db:migrate` run fail
 * outright, and a migration that cannot be re-run is a migration that cannot be rolled forward
 * after a partial failure.
 *
 * `tenant_id = 1` matches the convention `T116_001` states for `UNCATEGORIZED` and `T105_001`
 * states for the rule categories: these lists are read with no tenant filter
 * (`rewards.service.ts#listCategories` goes through `ScopedRepository` with no `tenantId`
 * predicate), so the column is a `NOT NULL` technicality here, not a per-tenant read scope. This
 * is deliberately **not** repeated for every tenant row in the database.
 *
 * No DDL: two `INSERT`s into tables `T116_001` created and already granted to `reward_app`
 * (`GRANT SELECT, INSERT, UPDATE`), so no new grant is needed. R1 is untouched — no
 * `reward_config` table is created, altered or dropped by this file.
 */
const CATEGORY_CODE = 'VOUCHER';
const CATEGORY_NAME = 'Voucher';
const SUB_CATEGORY_CODE = 'PROMO_CODE';
const SUB_CATEGORY_NAME = 'Promo Code';

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `INSERT INTO reward_config.reward_categories (tenant_id, category_code, name, description, status)
       SELECT 1, :categoryCode, :categoryName,
              'Rewards redeemed as a voucher or code rather than a credited amount.', 'active'
       WHERE NOT EXISTS (
         SELECT 1 FROM reward_config.reward_categories
         WHERE tenant_id = 1 AND category_code = :categoryCode
       );`,
      {
        type: QueryTypes.RAW,
        transaction: t,
        replacements: { categoryCode: CATEGORY_CODE, categoryName: CATEGORY_NAME },
      },
    );

    await context.query(
      `INSERT INTO reward_config.reward_sub_categories
         (category_id, sub_category_code, name, description, status)
       SELECT c.id, :subCategoryCode, :subCategoryName,
              'A code issued at redemption time by the promo code service; the reward version carries no amount.',
              'active'
       FROM reward_config.reward_categories c
       WHERE c.tenant_id = 1 AND c.category_code = :categoryCode
         AND NOT EXISTS (
           SELECT 1 FROM reward_config.reward_sub_categories
           WHERE category_id = c.id AND sub_category_code = :subCategoryCode
         );`,
      {
        type: QueryTypes.RAW,
        transaction: t,
        replacements: {
          categoryCode: CATEGORY_CODE,
          subCategoryCode: SUB_CATEGORY_CODE,
          subCategoryName: SUB_CATEGORY_NAME,
        },
      },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * Removes only the two rows `up()` added, sub-category first (`fk_rwsc_category`).
 *
 * The category delete is guarded on nothing still pointing at it — `reward_systems.category_id`
 * (T-118) and any other sub-category a Super Admin added under `VOUCHER` through T-117's manager
 * both outlive this migration. Rolling back must not take a real reward's category out from under
 * it, and `reward_systems.category_id` is `NOT NULL`, so an unguarded delete would either fail on
 * the FK or orphan live data depending on how the column was wired. Task file rollback note:
 * *"no data rows depend on it in a fresh environment"* — this guard is what makes that true in a
 * non-fresh one too.
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `DELETE FROM reward_config.reward_sub_categories sc
        USING reward_config.reward_categories c
        WHERE sc.category_id = c.id
          AND c.tenant_id = 1
          AND c.category_code = :categoryCode
          AND sc.sub_category_code = :subCategoryCode;`,
      {
        type: QueryTypes.RAW,
        transaction: t,
        replacements: { categoryCode: CATEGORY_CODE, subCategoryCode: SUB_CATEGORY_CODE },
      },
    );

    await context.query(
      `DELETE FROM reward_config.reward_categories c
        WHERE c.tenant_id = 1
          AND c.category_code = :categoryCode
          AND NOT EXISTS (
            SELECT 1 FROM reward_config.reward_sub_categories sc WHERE sc.category_id = c.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM reward_config.reward_systems rs WHERE rs.category_id = c.id
          );`,
      {
        type: QueryTypes.RAW,
        transaction: t,
        replacements: { categoryCode: CATEGORY_CODE },
      },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
