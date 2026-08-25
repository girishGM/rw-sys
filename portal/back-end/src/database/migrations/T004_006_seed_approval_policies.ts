import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Seeds one global default row into `reward_config.approval_policies` — 01-DATABASE.md
 * §5.5 note 5: `entity_type='campaign'`, `creator_role='maker'`, `requires_approval=true`,
 * `approver_role='checker'`, `tenant_id=NULL` (a `NULL` `tenant_id` is the global default a
 * tenant-specific policy overrides — see `approval-policy.model.ts`).
 *
 * **Deviation from implementation note 1, documented per AGENT-PROTOCOL §3.** Note 1 says
 * every seed uses `ON CONFLICT (<natural unique key>) DO NOTHING`. Verified against the
 * live database: unlike the other five seeded tables, `approval_policies` has **no unique
 * constraint at all** beyond its surrogate `id` primary key (confirmed via
 * `information_schema.table_constraints` — only `pk_approval_policies` and
 * `fk_ap_tenant` exist). Adding one would be a new constraint against `reward_config`,
 * forbidden by AGENT-PROTOCOL R1 ("no dropped constraints" — and, symmetrically here, no
 * *added* ones either; R1's point is that this schema is DDL-frozen except T-002's two
 * named `ALTER`s). `ON CONFLICT` needs an existing unique/exclusion constraint or index to
 * target, so it cannot be used here without that DDL. Idempotency is instead enforced in
 * application logic: `INSERT ... SELECT ... WHERE NOT EXISTS (...)`, matched on the same
 * natural key (`entity_type`, `creator_role`, `tenant_id IS NULL`) the `ON CONFLICT`
 * clauses use everywhere else. This still satisfies TC-2 (second run inserts zero rows) and
 * TC-14 (rollback removes only the seeded row) without touching the schema.
 *
 * The live database already holds one unrelated, pre-existing `approval_policies` row
 * (`tenant_id = 1`, dated 2026-08-12 — before this portal project's own work began, i.e.
 * real data from the underlying `reward_config` system, not portal test residue). This
 * seed's `WHERE NOT EXISTS` is scoped to `tenant_id IS NULL` specifically, so it can never
 * collide with, alter, or delete that unrelated row.
 */

export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `INSERT INTO reward_config.approval_policies
         (entity_type, creator_role, requires_approval, approver_role, tenant_id)
     SELECT 'campaign', 'maker', true, 'checker', NULL
     WHERE NOT EXISTS (
         SELECT 1 FROM reward_config.approval_policies
         WHERE entity_type = 'campaign' AND creator_role = 'maker' AND tenant_id IS NULL
     );`,
    { type: QueryTypes.RAW },
  );
}

/** Deletes exactly the one global default row this migration inserted, matched by its
 * natural key — the unrelated tenant-scoped row (and any other tenant-scoped policy added
 * later) is never touched. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `DELETE FROM reward_config.approval_policies
     WHERE entity_type = 'campaign' AND creator_role = 'maker' AND tenant_id IS NULL
       AND approver_role = 'checker' AND requires_approval = true;`,
    { type: QueryTypes.RAW },
  );
}
