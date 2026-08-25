import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Seeds `reward_config.role_entity_permissions` for the `grpc_grant` entity — the
 * `/admin/grpc-grants` surface 09-INTEGRATION.md §4d adds (architect review AR-09).
 *
 * `T004_001`'s seed matrix predates that decision and carries no row for it, so
 * `PermissionsGuard` (chain position 8) would refuse every call to the new controller — including
 * the `super_admin`'s — and T-047 TC-42 would fail with a 403 that looks like a bug in the guard
 * rather than a missing row. Exactly the same gap and the same fix as `T042_001`, whose header
 * records the reasoning for a separate, task-id-prefixed migration rather than an edit to
 * `T004_001` (05-EXECUTION-PLAN.md §3).
 *
 * **`super_admin` only, and no second row.** §4d: *"`GET · POST · PATCH /api/v1/admin/grpc-grants
 * [/:id]` super_admin only."* A `country_admin` with a `view` row would be able to enumerate which
 * external services read which tenants' configuration, which is the map of the integration
 * surface. TC-44 asserts the absence of every other role's row.
 *
 * `delete` is deliberately not among the actions: revocation is a status flip and `T047_001`
 * revokes `DELETE` on the table from `reward_app` outright, so an action nothing can perform is
 * not granted.
 *
 * Idempotent via `ON CONFLICT (role, entity) DO NOTHING`, same as `T004_001`.
 */

interface PermissionRow {
  role: string;
  entity: string;
  actions: string[];
}

export const GRPC_GRANT_PERMISSIONS: PermissionRow[] = [
  { role: 'super_admin', entity: 'grpc_grant', actions: ['view', 'create', 'update'] },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of GRPC_GRANT_PERMISSIONS) {
      await context.query(
        `INSERT INTO reward_config.role_entity_permissions (role, entity, actions)
         VALUES (:role, :entity, :actions)
         ON CONFLICT (role, entity) DO NOTHING;`,
        {
          type: QueryTypes.INSERT,
          transaction: t,
          replacements: {
            role: row.role,
            entity: row.entity,
            actions: JSON.stringify(row.actions),
          },
        },
      );
    }
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** R7 — deletes exactly the rows this migration inserted, matched by the natural key. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of GRPC_GRANT_PERMISSIONS) {
      await context.query(
        `DELETE FROM reward_config.role_entity_permissions WHERE role = :role AND entity = :entity;`,
        {
          type: QueryTypes.RAW,
          transaction: t,
          replacements: { role: row.role, entity: row.entity },
        },
      );
    }
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
