/**
 * T-127 — AGENT-PROTOCOL R7 for this task's one migration: *"every migration has a working
 * `down()` and is proven by migrate → rollback → migrate on a clean DB"*, plus TC-5 (the
 * `VOUCHER`/`PROMO_CODE` sub-category exists afterwards).
 *
 * Run directly rather than through `npm run db:rollback -- --all` for the reasons
 * `t037-migrations.e2e-spec.ts` sets out at length and which have not changed: `--all` is blocked
 * by `T056_001`'s crypto-building `down()` on this shared development database, and rolling the
 * whole stack back and forward while several agents work against it is a far worse thing to do
 * than proving the property on the one file this task owns.
 *
 * **What makes this more than a change-detector.** `T127_001` is a seed, so "did it run" is not
 * the interesting question — the interesting questions are whether the row it seeds is reachable
 * the way the product reaches it, and whether `down()` is honest about rows it did not create.
 * So the assertions below query through the same predicates
 * `RewardsService#listSubCategories` uses (`category_id = :id`, ordered by name, `status`
 * untouched) rather than re-stating the `INSERT`, and the `down()` case additionally proves the
 * guard: a `VOUCHER` category with another sub-category under it survives a rollback, because
 * dropping it would take a Super Admin's own row with it.
 */
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { createMigrationConnection } from '@/database/migration-connection';
import * as promoCodeSubCategory from '@/database/migrations/T127_001_seed_promo_code_subcategory';

jest.setTimeout(120_000);

let db: Sequelize;

interface CategoryRow {
  id: number;
  name: string;
  status: string;
}

async function voucherCategory(): Promise<CategoryRow | null> {
  const rows = await db.query<CategoryRow>(
    `SELECT id, name, status FROM reward_config.reward_categories
      WHERE tenant_id = 1 AND category_code = 'VOUCHER'`,
    { type: QueryTypes.SELECT },
  );
  return rows[0] ?? null;
}

/** The sub-categories of a category, read exactly the way `GET /reward-sub-categories?categoryId=`
 * reads them — by `category_id`, name-ordered, with no status filter of its own. */
async function subCategoriesOf(categoryId: number): Promise<CategoryRow[]> {
  return db.query<CategoryRow>(
    `SELECT sc.id, sc.name, sc.status FROM reward_config.reward_sub_categories sc
      WHERE sc.category_id = :categoryId
      ORDER BY sc.name ASC`,
    { type: QueryTypes.SELECT, replacements: { categoryId } },
  );
}

async function promoCodeSubCategoryExists(): Promise<boolean> {
  const category = await voucherCategory();
  if (category === null) return false;
  const rows = await db.query<{ code: string }>(
    `SELECT sub_category_code AS code FROM reward_config.reward_sub_categories
      WHERE category_id = :categoryId AND sub_category_code = 'PROMO_CODE'`,
    { type: QueryTypes.SELECT, replacements: { categoryId: category.id } },
  );
  return rows.length === 1;
}

beforeAll(async () => {
  db = createMigrationConnection();
  await db.authenticate();
});

afterAll(async () => {
  // Leave the database exactly as the suite found it: the migration applied.
  if (!(await promoCodeSubCategoryExists())) await promoCodeSubCategory.up({ context: db });
  await db.close();
});

describe('T127_001 — R7 migrate → rollback → migrate', () => {
  it('TC-5: the VOUCHER/PROMO_CODE sub-category is there to begin with, active and named', async () => {
    const category = await voucherCategory();
    expect(category).not.toBeNull();
    expect(category?.status).toBe('active');

    const subCategories = await subCategoriesOf(category?.id ?? 0);
    const promoCode = subCategories.find((row) => row.name === 'Promo Code');
    expect(promoCode).toBeDefined();
    expect(promoCode?.status).toBe('active');
  });

  it('rolls back cleanly, removing both rows it created', async () => {
    await promoCodeSubCategory.down({ context: db });

    expect(await promoCodeSubCategoryExists()).toBe(false);
    expect(await voucherCategory()).toBeNull();
  });

  it('re-applies cleanly, and is idempotent on a second run', async () => {
    await promoCodeSubCategory.up({ context: db });
    // A second `up()` must not trip `uq_rwc_tenant_code`/`uq_rwsc_category_code` — a migration
    // that cannot be re-run cannot be rolled forward after a partial failure.
    await promoCodeSubCategory.up({ context: db });

    const category = await voucherCategory();
    expect(category).not.toBeNull();
    expect(await subCategoriesOf(category?.id ?? 0)).toHaveLength(1);
  });

  it('down() keeps a VOUCHER category that something else is still using', async () => {
    const category = await voucherCategory();
    const categoryId = category?.id ?? 0;
    await db.query(
      `INSERT INTO reward_config.reward_sub_categories (category_id, sub_category_code, name, status)
       VALUES (:categoryId, 'T127_SPEC_OTHER', 'T-127 spec other', 'active')`,
      { type: QueryTypes.RAW, replacements: { categoryId } },
    );

    try {
      await promoCodeSubCategory.down({ context: db });

      // The seeded sub-category is gone; the category is not, because a row this migration never
      // created still hangs off it. An unguarded delete would have failed on `fk_rwsc_category`
      // or orphaned that row.
      expect(await promoCodeSubCategoryExists()).toBe(false);
      const survivor = await voucherCategory();
      expect(survivor).not.toBeNull();
      expect(await subCategoriesOf(survivor?.id ?? 0)).toHaveLength(1);
    } finally {
      await db.query(
        `DELETE FROM reward_config.reward_sub_categories WHERE sub_category_code = 'T127_SPEC_OTHER'`,
        { type: QueryTypes.RAW },
      );
      await promoCodeSubCategory.up({ context: db });
    }
  });
});
