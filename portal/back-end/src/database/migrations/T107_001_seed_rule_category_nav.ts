import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-107 — seeds `reward_config.role_nav_configs` with a `/rule-categories` entry for
 * `super_admin` — the sidebar (`layouts/Sidebar.tsx`) reads `useBootstrap().nav`, which is built
 * from this table, not from `router.tsx`'s route list. Without this row the new Categories page
 * is reachable only by typing the URL directly — the same gap `T042_002`'s own header describes
 * for `/definition-requests`, and the same fix.
 *
 * `super_admin` only: creating/editing rule masters (and, by extension, their categories) is
 * already `super_admin`-only (`rules.service.ts#create`'s `assertRole`) — every other role can
 * still *view* categories (T-106's permission seed grants `view` broadly) via the existing
 * `AddRuleModal` cascading picker, so a dedicated nav entry for a page whose write controls they
 * can never see would be nav clutter, not a real capability.
 *
 * Idempotent via `ON CONFLICT (role, nav_key) DO NOTHING`, same as `T042_002`.
 */
interface NavRow {
  role: string;
  navKey: string;
  label: string;
  path: string;
  sortOrder: number;
}

export const RULE_CATEGORY_NAV_CONFIGS: NavRow[] = [
  {
    role: 'super_admin',
    navKey: 'rule_categories',
    label: 'Categories',
    path: '/rule-categories',
    sortOrder: 31,
  },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of RULE_CATEGORY_NAV_CONFIGS) {
      await context.query(
        `INSERT INTO reward_config.role_nav_configs (role, nav_key, label, path, sort_order)
         VALUES (:role, :navKey, :label, :path, :sortOrder)
         ON CONFLICT (role, nav_key) DO NOTHING;`,
        {
          type: QueryTypes.INSERT,
          transaction: t,
          replacements: row as unknown as Record<string, unknown>,
        },
      );
    }
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of RULE_CATEGORY_NAV_CONFIGS) {
      await context.query(
        `DELETE FROM reward_config.role_nav_configs WHERE role = :role AND nav_key = :navKey;`,
        {
          type: QueryTypes.RAW,
          transaction: t,
          replacements: { role: row.role, navKey: row.navKey },
        },
      );
    }
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
