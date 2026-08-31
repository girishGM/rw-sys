import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-146 — seeds `reward_config.role_nav_configs` with a `/rule-value-sources` entry for
 * `super_admin`, the exact mirror of `T107_001_seed_rule_category_nav.ts`: the sidebar
 * (`layouts/Sidebar.tsx`) reads `useBootstrap().nav`, which is built from this table, not from
 * `router.tsx`'s route list — without this row the new Value Sources page built by this task is
 * reachable only by typing the URL directly.
 *
 * `super_admin` only, same reasoning `T107_001`'s own header gives: every other role can still
 * reach the underlying registries indirectly (they already flow into the rule parameter-field
 * picker every role sees), so a dedicated nav entry for a page whose whole purpose is Super
 * Admin's own "what's available while building a rule version" reference view would be nav
 * clutter for anyone else.
 *
 * Idempotent via `ON CONFLICT (role, nav_key) DO NOTHING`, same as `T107_001`.
 */
interface NavRow {
  role: string;
  navKey: string;
  label: string;
  path: string;
  sortOrder: number;
}

export const RULE_VALUE_SOURCES_NAV_CONFIGS: NavRow[] = [
  {
    role: 'super_admin',
    navKey: 'rule_value_sources',
    label: 'Value Sources',
    path: '/rule-value-sources',
    // `T107_001`'s own `rule_categories` sits at 31, directly under `rules`'s 30; `T117_001`'s
    // `reward_categories` sits at 41, directly under `rewards`'s 40. 32 places this directly
    // after Categories, still ahead of Rewards.
    sortOrder: 32,
  },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of RULE_VALUE_SOURCES_NAV_CONFIGS) {
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
    for (const row of RULE_VALUE_SOURCES_NAV_CONFIGS) {
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
