import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_portal.portal_campaign_audit_trail` — T-037, closing the **original** instance of the
 * `admin_users` foreign-key gap: the one T-014 named first and left open.
 *
 * ### What T-014 already established, verbatim
 *
 * `audit.service.ts#recordDomainEvent`'s own header: *"`campaign_audit_trail.performed_by`
 * carries `fk_cat_performed_by → reward_config.admin_users(id)` … When no link exists, the row is
 * **skipped** rather than attempted … **This is a live design gap** — the `maker` and `checker`
 * roles, which are precisely the roles that create and approve campaigns, cannot be represented
 * in `admin_users` at all (gap G1), so unless Wave 3 provides `performedBy` explicitly they will
 * produce no domain audit rows. Escalated in the T-014 completion report."*
 *
 * T-037 is the first task that actually writes campaign audit, so this is where "unless Wave 3
 * provides `performedBy` explicitly" comes due — and there is no value it could provide, because
 * no `admin_users` row for a maker can exist to be provided. Verified live: `admin_users` holds 2
 * rows, `portal_users.admin_user_id` is populated for **0** of them, and `ck_admin_users_role`
 * excludes `maker`/`checker` outright.
 *
 * The resolution is the one the architect already accepted for the identical gap in T-040
 * (`T040_001_portal_user_notifications.ts`): a `reward_portal`-owned table whose actor columns
 * reference `reward_portal.portal_users(id)`. `reward_config.campaign_audit_trail` is left in
 * place and untouched (R1).
 *
 * ### Append-only, enforced at the privilege level
 *
 * 01-DATABASE.md §3 treats the original table as append-only — *"Audit is append-only. No UPDATE,
 * no DELETE, by anyone, ever"* — with an explicit `REVOKE UPDATE, DELETE` after the grant. This
 * table gets the same treatment rather than merely the same intention: `reward_app` holds
 * `SELECT, INSERT` and nothing else on it, so an ORM bug or an injected statement cannot rewrite
 * history. Note that `reward_portal`'s `ALTER DEFAULT PRIVILEGES … GRANT ALL` (T002_008) would
 * otherwise have handed this table full privileges automatically — the `REVOKE` below is what
 * makes that default safe here, and it is why this migration grants explicitly instead of
 * relying on inheritance.
 *
 * ### Shape
 *
 * Column-for-column mirror of the live `reward_config.campaign_audit_trail`, with three
 * deliberate differences:
 *
 *  1. `performed_by` / `approved_by` reference `reward_portal.portal_users(id)` — the fix.
 *  2. `approval_request_id` references `reward_portal.portal_approval_requests(id)` (T037_001),
 *     the portal-side replacement for the same reason. T-038 TC-23 depends on this link.
 *  3. `field_changes` is `jsonb`, not `text` — same reasoning as T037_001's `payload`.
 *
 * `ck_pcat_action` and `ck_pcat_entity_type` restate the original's vocabularies exactly, so a
 * row written here is interchangeable with one written there and a future consolidation needs no
 * translation table.
 *
 * ### One consequence, disclosed rather than hidden
 *
 * `GET /audit/campaigns` (T-040, `audit-viewer.service.ts`) reads
 * `reward_config.campaign_audit_trail` and will therefore not show portal-authored campaign
 * audit until it is pointed here. That file is outside this task's scope (R9) and T-040 is
 * `done`; `GET /campaigns/:id/audit` — which **is** this task's — reads this table, so the trail
 * is fully visible on the campaign itself. Flagged in the T-037 completion report as a one-line
 * follow-up for whoever owns the audit viewer next.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_portal.portal_campaign_audit_trail (
          id                    int generated always as identity primary key,
          tenant_id             int           not null,
          campaign_id           int           not null,
          entity_type           varchar(40)   not null,
          entity_id             int           null,
          action                varchar(20)   not null,
          field_changes         jsonb         null,
          performed_by          int           not null,
          performed_at          timestamptz   not null default now(),
          approved_by           int           null,
          approved_at           timestamptz   null,
          approval_request_id   int           null,
          comment               varchar(500)  null,
          retention_expires_at  timestamptz   not null default (now() + interval '7 years'),

          constraint ck_pcat_action check (action in (
              'created','updated','deleted','submitted','approved','rejected',
              'assigned','unassigned','status_changed')),
          constraint ck_pcat_entity_type check (entity_type in (
              'campaign','tracker','tracker_component','rule_assignment','reward_assignment',
              'cap_override','entity_assignment','campaign_submit','campaign_approval')),
          constraint fk_pcat_tenant foreign key (tenant_id)
              references reward_config.tenants(id) on delete restrict,
          constraint fk_pcat_campaign foreign key (campaign_id)
              references reward_config.tenant_campaigns(id) on delete restrict,
          constraint fk_pcat_performed_by foreign key (performed_by)
              references reward_portal.portal_users(id) on delete restrict,
          constraint fk_pcat_approved_by foreign key (approved_by)
              references reward_portal.portal_users(id) on delete restrict,
          constraint fk_pcat_approval_request foreign key (approval_request_id)
              references reward_portal.portal_approval_requests(id) on delete restrict
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `CREATE INDEX ix_pcat_campaign
           ON reward_portal.portal_campaign_audit_trail(campaign_id, performed_at desc, id desc);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // Append-only at the privilege level — see this file's header.
    await context.query(
      'GRANT SELECT, INSERT ON reward_portal.portal_campaign_audit_trail TO reward_app;',
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      'REVOKE UPDATE, DELETE, TRUNCATE ON reward_portal.portal_campaign_audit_trail FROM reward_app;',
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** Dropped before `T037_001`'s table, since this one holds the FK to it. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_portal.portal_campaign_audit_trail CASCADE;', {
    type: QueryTypes.RAW,
  });
}
