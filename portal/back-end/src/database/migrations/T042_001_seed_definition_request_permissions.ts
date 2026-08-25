import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Seeds `reward_config.role_entity_permissions` for the `definition_request` entity —
 * T-042's own addition, since `01-DATABASE.md §5.1`/`T004_001`'s seed predates
 * `definition_requests` (T-005) and carries no row for it (the same gap `versions.constants.ts`
 * documents for `version`/`blast`, except this task's implementation note 8 is explicit that a
 * real row belongs here: *"maker, checker and merchant have no access — the seed matrix grants
 * definition_request to country_admin, tenant_admin and super_admin only"*).
 *
 * A new, task-id-prefixed migration rather than an edit to `T004_001` — `05-EXECUTION-PLAN.md
 * §3`: *"Migration filenames are prefixed with the task id ... so two agents cannot collide on a
 * sequence number"*; `T004_001` is outside this task's `Files owned`.
 *
 * Idempotent via `ON CONFLICT (role, entity) DO NOTHING`, same as `T004_001`.
 */

interface PermissionRow {
  role: string;
  entity: string;
  actions: string[];
}

export const DEFINITION_REQUEST_PERMISSIONS: PermissionRow[] = [
  // super_admin triages (review/fulfil) and sees every request.
  { role: 'super_admin', entity: 'definition_request', actions: ['view', 'review', 'fulfil'] },
  // country_admin/tenant_admin raise, edit-while-submitted and withdraw their own.
  {
    role: 'country_admin',
    entity: 'definition_request',
    actions: ['view', 'create', 'update', 'withdraw'],
  },
  {
    role: 'tenant_admin',
    entity: 'definition_request',
    actions: ['view', 'create', 'update', 'withdraw'],
  },
  // maker/checker/merchant: no row at all (implementation note 8, TC-4/TC-5).
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of DEFINITION_REQUEST_PERMISSIONS) {
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

/** Deletes exactly the rows this migration inserted, matched by the natural key
 * (role, entity) — any row a Super Admin later hand-edited through the Access Control screen is
 * still deleted here, matching `T004_001`'s own documented reasoning for the same trade-off. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of DEFINITION_REQUEST_PERMISSIONS) {
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
