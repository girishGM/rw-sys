import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-116 — permission entities for the new `reward_category`/`reward_sub_category` write actions.
 * `T004_001_seed_role_entity_permissions.ts` is owned by an already-`done` task (R9) and Umzug
 * never re-runs an applied migration's `up()` — same reasoning `T106_001`'s own header gives for
 * adding a new, later-numbered migration rather than editing it in place.
 *
 * `view` is unconditionally available on `GET /reward-categories`/`GET /reward-sub-categories`
 * via `@Roles(...ALL_PORTAL_ROLES)` on `RewardCategoriesController`, not `@RequirePermission` —
 * matching `rule-categories.controller.ts`'s own precedent (T-106's header). This migration only
 * adds what the new `create`/`update` endpoints need — `view` rows are seeded too, for
 * consistency with every other entity's permission matrix and so a future permissions-management
 * screen has something real to show, but they are not load-bearing for the existing read
 * endpoints.
 *
 * `super_admin`: full `view/create/update` (no `delete` — T-116 deliberately doesn't add one,
 * matching T-106's own precedent for `rule_category`/`rule_sub_category`). Every other role:
 * `view` only.
 */
interface PermissionRow {
  role: string;
  entity: string;
  actions: string[];
}

export const REWARD_CATEGORY_PERMISSIONS: PermissionRow[] = [
  { role: 'super_admin', entity: 'reward_category', actions: ['view', 'create', 'update'] },
  { role: 'country_admin', entity: 'reward_category', actions: ['view'] },
  { role: 'tenant_admin', entity: 'reward_category', actions: ['view'] },
  { role: 'maker', entity: 'reward_category', actions: ['view'] },
  { role: 'checker', entity: 'reward_category', actions: ['view'] },
  { role: 'merchant', entity: 'reward_category', actions: ['view'] },

  { role: 'super_admin', entity: 'reward_sub_category', actions: ['view', 'create', 'update'] },
  { role: 'country_admin', entity: 'reward_sub_category', actions: ['view'] },
  { role: 'tenant_admin', entity: 'reward_sub_category', actions: ['view'] },
  { role: 'maker', entity: 'reward_sub_category', actions: ['view'] },
  { role: 'checker', entity: 'reward_sub_category', actions: ['view'] },
  { role: 'merchant', entity: 'reward_sub_category', actions: ['view'] },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of REWARD_CATEGORY_PERMISSIONS) {
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

export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of REWARD_CATEGORY_PERMISSIONS) {
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
