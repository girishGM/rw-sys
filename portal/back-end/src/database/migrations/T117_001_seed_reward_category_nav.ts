import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-117 — seeds `reward_config.role_nav_configs` with a `/reward-categories` entry for
 * `super_admin`, the exact mirror of `T107_001_seed_rule_category_nav.ts` for the reward side:
 * the sidebar (`layouts/Sidebar.tsx`) reads `useBootstrap().nav`, which is built from this
 * table, not from `router.tsx`'s route list — without this row the new Reward Categories page
 * built by this task is reachable only by typing the URL directly.
 *
 * `super_admin` only, same reasoning `T107_001`'s own header gives: creating/editing reward
 * masters (and, by extension, their categories) is already `super_admin`-only
 * (`rewards.service.ts#create`'s `assertRole`); every other role can still *view* categories
 * (T-116's permission seed grants `view` broadly), so a dedicated nav entry for a page whose
 * write controls they can never see would be nav clutter, not a real capability.
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

export const REWARD_CATEGORY_NAV_CONFIGS: NavRow[] = [
  {
    role: 'super_admin',
    navKey: 'reward_categories',
    label: 'Categories',
    path: '/reward-categories',
    // `T004_002`'s own seed: super_admin's `rewards` entry sits at `sortOrder: 40`, `users` at
    // `50` — `41` places this directly under "Rewards", the same relative position
    // `T107_001`'s `rule_categories` (`31`, directly under `rules`'s `30`) holds for Rules.
    sortOrder: 41,
  },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of REWARD_CATEGORY_NAV_CONFIGS) {
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
    for (const row of REWARD_CATEGORY_NAV_CONFIGS) {
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
