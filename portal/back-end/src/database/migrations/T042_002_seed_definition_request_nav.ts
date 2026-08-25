import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Seeds `reward_config.role_nav_configs` with a `/definition-requests` entry for the three
 * roles this task grants the entity to (`T042_001`'s own seed) — otherwise the screen
 * (06-VERSIONING.md §10, "Definition requests | all (raise), super_admin (triage)") is reachable
 * only by typing the URL directly, the same gap this task's own `router.tsx` addition would
 * otherwise leave unfilled. A new, task-id-prefixed migration, the same reasoning
 * `T042_001_seed_definition_request_permissions.ts`'s own header gives for not editing
 * `T004_002` directly.
 *
 * Idempotent via `ON CONFLICT (role, nav_key) DO NOTHING`, same as `T004_002`.
 */

interface NavRow {
  role: string;
  navKey: string;
  label: string;
  path: string;
  sortOrder: number;
}

export const DEFINITION_REQUEST_NAV_CONFIGS: NavRow[] = [
  {
    role: 'super_admin',
    navKey: 'definition_requests',
    label: 'Definition Requests',
    path: '/definition-requests',
    sortOrder: 45,
  },
  {
    role: 'country_admin',
    navKey: 'definition_requests',
    label: 'Definition Requests',
    path: '/definition-requests',
    sortOrder: 45,
  },
  {
    role: 'tenant_admin',
    navKey: 'definition_requests',
    label: 'Definition Requests',
    path: '/definition-requests',
    sortOrder: 45,
  },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of DEFINITION_REQUEST_NAV_CONFIGS) {
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

/** Deletes exactly the rows this migration inserted, matched by the natural key
 * (role, nav_key) — any nav row Super Admin added afterwards through the UI is untouched. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of DEFINITION_REQUEST_NAV_CONFIGS) {
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
