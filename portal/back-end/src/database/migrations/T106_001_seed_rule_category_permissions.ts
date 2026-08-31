import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-106 — permission entities for the new `rule_category`/`rule_sub_category` write actions.
 * `T004_001_seed_role_entity_permissions.ts` is owned by an already-`done` task (R9) and Umzug
 * never re-runs an applied migration's `up()` — same reasoning `T091_001`'s own header gives for
 * adding a new, later-numbered migration rather than editing it in place.
 *
 * `view` is already unconditionally available on the existing `GET /rule-categories`/
 * `GET /rule-sub-categories` endpoints (`@Roles(...ALL_PORTAL_ROLES)`, no
 * `@RequirePermission` — confirmed, matches `rule-categories.controller.ts`'s own header
 * comment). This migration only adds what the new `create`/`update` endpoints need — `view` rows
 * are seeded too, for consistency with every other entity's permission matrix and so a future
 * permissions-management screen has something real to show, but they are not load-bearing for
 * the existing read endpoints.
 *
 * `super_admin`: full `view/create/update` (no `delete` — T-106 deliberately doesn't add one).
 * Every other role: `view` only — matching the `rule`/`reward` entities' own precedent
 * (`T004_001` lines 55-68).
 */
interface PermissionRow {
  role: string;
  entity: string;
  actions: string[];
}

export const RULE_CATEGORY_PERMISSIONS: PermissionRow[] = [
  { role: 'super_admin', entity: 'rule_category', actions: ['view', 'create', 'update'] },
  { role: 'country_admin', entity: 'rule_category', actions: ['view'] },
  { role: 'tenant_admin', entity: 'rule_category', actions: ['view'] },
  { role: 'maker', entity: 'rule_category', actions: ['view'] },
  { role: 'checker', entity: 'rule_category', actions: ['view'] },
  { role: 'merchant', entity: 'rule_category', actions: ['view'] },

  { role: 'super_admin', entity: 'rule_sub_category', actions: ['view', 'create', 'update'] },
  { role: 'country_admin', entity: 'rule_sub_category', actions: ['view'] },
  { role: 'tenant_admin', entity: 'rule_sub_category', actions: ['view'] },
  { role: 'maker', entity: 'rule_sub_category', actions: ['view'] },
  { role: 'checker', entity: 'rule_sub_category', actions: ['view'] },
  { role: 'merchant', entity: 'rule_sub_category', actions: ['view'] },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of RULE_CATEGORY_PERMISSIONS) {
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
    for (const row of RULE_CATEGORY_PERMISSIONS) {
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
