import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-126 — permission entity for the new `tenant_currency` reads/writes. Follows `T106_001`'s
 * exact pattern (own header explains the "new, later-numbered migration rather than editing
 * `T004_001` in place" reasoning, itself citing `T091_001`).
 *
 * `super_admin`: `view/create/update` (no `delete` — the same "retire via status, never remove
 * the row" discipline `rule_category`/`rule_sub_category` (T-106) already established). Every
 * other role: `view` only (implementation note 4) — unlike `tenant`/`tenant_budget_ceiling`
 * (`T004_001`, `tenant_admin`-and-above only), a currency *list* is something every role that can
 * see a tenant at all needs to render a picker, right down to `merchant` (13-REWARD-MASTER-
 * VALUE-SOURCES.md §4: the Reward Master's multi-currency value editor reads this list).
 */
interface PermissionRow {
  role: string;
  entity: string;
  actions: string[];
}

export const TENANT_CURRENCY_PERMISSIONS: PermissionRow[] = [
  { role: 'super_admin', entity: 'tenant_currency', actions: ['view', 'create', 'update'] },
  { role: 'country_admin', entity: 'tenant_currency', actions: ['view'] },
  { role: 'tenant_admin', entity: 'tenant_currency', actions: ['view'] },
  { role: 'maker', entity: 'tenant_currency', actions: ['view'] },
  { role: 'checker', entity: 'tenant_currency', actions: ['view'] },
  { role: 'merchant', entity: 'tenant_currency', actions: ['view'] },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of TENANT_CURRENCY_PERMISSIONS) {
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
    for (const row of TENANT_CURRENCY_PERMISSIONS) {
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
