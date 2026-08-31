import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-157 — nests `super_admin`'s "Rules" and "Rewards" top-level nav rows into expandable groups
 * (`Sidebar.tsx`/`buildNavTree.ts` already render `parent_nav_key`-nested rows as a collapsible
 * `NavGroup`; the gap was purely in the seed data, not the renderer — see this task's own file
 * header for the confirmed root cause).
 *
 * Two independent changes, both idempotent:
 *
 * 1. **`NEW_NAV_ROWS`** — inserts an "All Rules" (`rules_all`, `/rules`) and an "All Rewards"
 *    (`rewards_all`, `/rewards`) row, each `parent_nav_key`'d under the existing top-level `rules`/
 *    `rewards` row `T004_002` already seeds. `sort_order` 29/39 (one below the parent's own 30/40)
 *    rather than "parent + 1" (the convention `T107_001`/`T117_001`/`T146_001` use for the
 *    *other* children below): `buildNavTree` (`back-end/src/modules/me/bootstrap.service.ts`)
 *    places a child into its parent's bucket in the same global `sort_order` order the whole
 *    role's rows arrive in, regardless of the child's `sort_order` relative to the parent's own —
 *    so 29/39 only has to beat `rule_categories`/`rule_value_sources` (31/32) and
 *    `reward_categories` (41) to make "All Rules"/"All Rewards" the *first* child, which it does.
 *    Both values are also unique within `super_admin`'s own rows (confirmed by inspection against
 *    `T004_002`'s and every later nav-seeding migration's own `sortOrder`), so this introduces no
 *    `ORDER BY sort_order` tie for the flat, single-key-sorted assertion
 *    `test/database/t004-seeds-bootstrap.e2e-spec.ts`'s own §5.2 check relies on.
 *
 * 2. **`RENESTED_ROWS`** — `UPDATE`s the three existing, already-live `super_admin` rows
 *    `T107_001`/`T117_001`/`T146_001` seeded flat (`rule_categories`, `rule_value_sources`,
 *    `reward_categories`) to set the `parent_nav_key` those migrations left `NULL`. Guarded by
 *    `AND parent_nav_key IS NULL` so a second `up()` run is a no-op rather than a redundant write,
 *    and so this never clobbers a `parent_nav_key` a Super Admin has since changed by hand through
 *    T-033's nav-config editor.
 *
 * `country_admin`'s own flat `rules`/`rewards` rows (`T004_002`, labelled "Assigned Rules"/
 * "Assigned Rewards") are deliberately untouched — `rule_categories`/`rule_value_sources`/
 * `reward_categories` are `super_admin`-only nav entries (each one's own migration header says so:
 * write access to rule/reward masters, and by extension their categories, is `super_admin`-only),
 * so `country_admin` has no Categories/Value-Sources siblings to re-parent in the first place.
 *
 * The Basic Standard's own Maker-facing "add a rule to a campaign" flow (`AddRuleModal`/picker
 * components) does not read `role_nav_configs` at all — it queries the rule/category/value-source
 * *data* endpoints directly — so nothing here can regress it; confirmed by inspection, not
 * assumed (grep for `role_nav_configs`/`useBootstrap().nav` under
 * `front-end/src/features/campaigns/**` and `front-end/src/features/rules/AddRuleModal.tsx`
 * returns no matches).
 */

interface NewNavRow {
  role: string;
  navKey: string;
  label: string;
  path: string;
  parentNavKey: string;
  sortOrder: number;
}

interface RenestedRow {
  role: string;
  navKey: string;
  parentNavKey: string;
}

export const NEW_NAV_ROWS: NewNavRow[] = [
  {
    role: 'super_admin',
    navKey: 'rules_all',
    label: 'All Rules',
    path: '/rules',
    parentNavKey: 'rules',
    sortOrder: 29,
  },
  {
    role: 'super_admin',
    navKey: 'rewards_all',
    label: 'All Rewards',
    path: '/rewards',
    parentNavKey: 'rewards',
    sortOrder: 39,
  },
];

export const RENESTED_ROWS: RenestedRow[] = [
  { role: 'super_admin', navKey: 'rule_categories', parentNavKey: 'rules' },
  { role: 'super_admin', navKey: 'rule_value_sources', parentNavKey: 'rules' },
  { role: 'super_admin', navKey: 'reward_categories', parentNavKey: 'rewards' },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of NEW_NAV_ROWS) {
      await context.query(
        `INSERT INTO reward_config.role_nav_configs
           (role, nav_key, label, path, parent_nav_key, sort_order)
         VALUES (:role, :navKey, :label, :path, :parentNavKey, :sortOrder)
         ON CONFLICT (role, nav_key) DO NOTHING;`,
        {
          type: QueryTypes.INSERT,
          transaction: t,
          replacements: row as unknown as Record<string, unknown>,
        },
      );
    }

    for (const row of RENESTED_ROWS) {
      await context.query(
        `UPDATE reward_config.role_nav_configs
            SET parent_nav_key = :parentNavKey, updated_at = now()
          WHERE role = :role AND nav_key = :navKey AND parent_nav_key IS NULL;`,
        {
          type: QueryTypes.UPDATE,
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

/** Reverses both halves of `up()`: re-flattens the three re-nested rows, then deletes exactly the
 * two rows this migration inserted — the same natural-key-matched, "leave anything else alone"
 * shape `T004_002`'s own `down()` uses. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of RENESTED_ROWS) {
      await context.query(
        `UPDATE reward_config.role_nav_configs
            SET parent_nav_key = NULL, updated_at = now()
          WHERE role = :role AND nav_key = :navKey AND parent_nav_key = :parentNavKey;`,
        {
          type: QueryTypes.UPDATE,
          transaction: t,
          replacements: row as unknown as Record<string, unknown>,
        },
      );
    }

    for (const row of NEW_NAV_ROWS) {
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
