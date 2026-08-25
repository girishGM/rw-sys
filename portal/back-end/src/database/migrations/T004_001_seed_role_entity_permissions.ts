import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Seeds `reward_config.role_entity_permissions` — the authoritative permission matrix,
 * verbatim from 01-DATABASE.md §5.1 (gap G7). `role_entity_permissions` was created by the
 * original `reward_config` schema (T-003 models it) but ships empty — without this seed
 * the portal has no permissions at all and every RBAC check (T-013) fails closed.
 *
 * **Not DDL.** `reward_config.role_entity_permissions` already exists with
 * `uq_role_entity_perms_role_entity UNIQUE (role, entity)` (confirmed against the live
 * database, not assumed from the doc) — this migration only inserts rows, respecting
 * AGENT-PROTOCOL R1 (no `reward_config` DDL beyond T-002's two authorised `ALTER`s).
 *
 * Idempotent via `ON CONFLICT (role, entity) DO NOTHING` — a second run changes nothing
 * (TC-2), and a value hand-edited afterwards survives a re-run untouched (TC-3, `DO
 * NOTHING` is not an upsert).
 *
 * Rows marked in the doc as encoding the product's core authority rules (bold there) are
 * called out below because T-013 and T-031 assert against them directly — do not
 * "simplify" `rule`/`reward` down to a single `view` for every role, and do not give
 * `maker` anything beyond `view` on `rule`/`reward` (TC-5).
 */

interface PermissionRow {
  role: string;
  entity: string;
  actions: string[];
}

// Verbatim transcription of 01-DATABASE.md §5.1. Every cell that is not "—" becomes a row.
export const ROLE_ENTITY_PERMISSIONS: PermissionRow[] = [
  // country
  { role: 'super_admin', entity: 'country', actions: ['view', 'create', 'update'] },
  { role: 'country_admin', entity: 'country', actions: ['view'] },

  // tenant
  { role: 'super_admin', entity: 'tenant', actions: ['view'] },
  { role: 'country_admin', entity: 'tenant', actions: ['view', 'create', 'update'] },
  { role: 'tenant_admin', entity: 'tenant', actions: ['view'] },

  // user
  { role: 'super_admin', entity: 'user', actions: ['view', 'create', 'update', 'delete'] },
  { role: 'country_admin', entity: 'user', actions: ['view', 'create', 'update'] },
  { role: 'tenant_admin', entity: 'user', actions: ['view', 'create', 'update'] },

  // merchant
  { role: 'super_admin', entity: 'merchant', actions: ['view'] },
  { role: 'country_admin', entity: 'merchant', actions: ['view'] },
  { role: 'tenant_admin', entity: 'merchant', actions: ['view', 'create', 'update'] },
  { role: 'maker', entity: 'merchant', actions: ['view'] },
  { role: 'checker', entity: 'merchant', actions: ['view'] },
  { role: 'merchant', entity: 'merchant', actions: ['view'] },

  // rule — core product rule: only super_admin may create/update/delete (TC-6); maker gets
  // view only, never create (TC-5).
  { role: 'super_admin', entity: 'rule', actions: ['view', 'create', 'update', 'delete'] },
  { role: 'country_admin', entity: 'rule', actions: ['view'] },
  { role: 'tenant_admin', entity: 'rule', actions: ['view'] },
  { role: 'maker', entity: 'rule', actions: ['view'] },
  { role: 'checker', entity: 'rule', actions: ['view'] },

  // reward — same shape as rule.
  { role: 'super_admin', entity: 'reward', actions: ['view', 'create', 'update', 'delete'] },
  { role: 'country_admin', entity: 'reward', actions: ['view'] },
  { role: 'tenant_admin', entity: 'reward', actions: ['view'] },
  { role: 'maker', entity: 'reward', actions: ['view'] },
  { role: 'checker', entity: 'reward', actions: ['view'] },

  // tenant_budget_ceiling
  { role: 'super_admin', entity: 'tenant_budget_ceiling', actions: ['view'] },
  {
    role: 'country_admin',
    entity: 'tenant_budget_ceiling',
    actions: ['view', 'create', 'update'],
  },
  { role: 'tenant_admin', entity: 'tenant_budget_ceiling', actions: ['view'] },

  // rule_assignment
  { role: 'super_admin', entity: 'rule_assignment', actions: ['view', 'create', 'delete'] },
  { role: 'country_admin', entity: 'rule_assignment', actions: ['view'] },

  // reward_assignment
  { role: 'super_admin', entity: 'reward_assignment', actions: ['view', 'create', 'delete'] },
  { role: 'country_admin', entity: 'reward_assignment', actions: ['view'] },

  // campaign
  { role: 'super_admin', entity: 'campaign', actions: ['view'] },
  { role: 'country_admin', entity: 'campaign', actions: ['view'] },
  { role: 'tenant_admin', entity: 'campaign', actions: ['view'] },
  { role: 'maker', entity: 'campaign', actions: ['view', 'create', 'update', 'submit'] },
  { role: 'checker', entity: 'campaign', actions: ['view', 'approve', 'reject', 'return'] },
  { role: 'merchant', entity: 'campaign', actions: ['view'] },

  // approval
  { role: 'super_admin', entity: 'approval', actions: ['view'] },
  { role: 'country_admin', entity: 'approval', actions: ['view'] },
  { role: 'tenant_admin', entity: 'approval', actions: ['view'] },
  { role: 'maker', entity: 'approval', actions: ['view'] },
  { role: 'checker', entity: 'approval', actions: ['view', 'approve', 'reject'] },

  // access_control — super_admin only (TC-7: exactly one row).
  {
    role: 'super_admin',
    entity: 'access_control',
    actions: ['view', 'create', 'update', 'delete'],
  },

  // grpc_grant — added 2026-08-14, architect review AR-09.
  { role: 'super_admin', entity: 'grpc_grant', actions: ['view', 'create', 'update'] },

  // audit
  { role: 'super_admin', entity: 'audit', actions: ['view'] },
  { role: 'country_admin', entity: 'audit', actions: ['view'] },
  { role: 'tenant_admin', entity: 'audit', actions: ['view'] },
  { role: 'checker', entity: 'audit', actions: ['view'] },

  // notification — every role.
  { role: 'super_admin', entity: 'notification', actions: ['view', 'update'] },
  { role: 'country_admin', entity: 'notification', actions: ['view', 'update'] },
  { role: 'tenant_admin', entity: 'notification', actions: ['view', 'update'] },
  { role: 'maker', entity: 'notification', actions: ['view', 'update'] },
  { role: 'checker', entity: 'notification', actions: ['view', 'update'] },
  { role: 'merchant', entity: 'notification', actions: ['view', 'update'] },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of ROLE_ENTITY_PERMISSIONS) {
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

/** Deletes exactly the rows this migration inserted, matched by the natural key. Any row a
 * Super Admin later hand-edited (label/actions changed via the UI) is still deleted here,
 * because the natural key (role, entity) — not the content — identifies "this seed row";
 * that mirrors TC-14 ("only seeded rows removed"), which is about *extra*, non-seeded rows
 * surviving, not about edits to a seeded row being preserved through a rollback.
 *
 * This intentionally includes rows a later migration has since UPDATEd in place (e.g.
 * `T047_003`, which rewrites the `tenant_admin`/`campaign` row's `actions`) — deleting and
 * re-inserting them with this migration's own original value is correct *migration* behaviour
 * (a real rollback undoes every migration back to this point, `T047_003` included, in reverse
 * order through Umzug). It is only wrong if something calls this `down()`/`up()` pair directly,
 * bypassing that order — which is exactly what `test/database/t004-seeds-bootstrap.e2e-spec.ts`
 * TC-14 does, deliberately, to test this migration in isolation. That test owns reapplying any
 * such downstream UPDATE afterwards (`PERMISSION_UPDATE_MIGRATIONS`) — see T-073. Nothing here
 * needs to change to support that. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of ROLE_ENTITY_PERMISSIONS) {
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
