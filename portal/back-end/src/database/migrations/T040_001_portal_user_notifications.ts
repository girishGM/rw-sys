import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_portal.portal_user_notifications` — T-040 retry 1, resolving the escalation this
 * task's own first review confirmed live: **the fix for the structural gap T-014 first named
 * for `campaign_audit_trail.performed_by` and this task's completion report named again for
 * `reward_config.user_notifications.user_id`.**
 *
 * ### Why a new table, not a fix to the existing one
 *
 * `reward_config.user_notifications.user_id` carries `fk_un_user →
 * reward_config.admin_users(id)`, but `scope-strategy.ts`'s already-shipped strategy for the
 * feed reads it against `RequestScope.userId`, which **is** `reward_portal.portal_users.id`
 * (`scope-context.ts`). The two id spaces are independent and, per `admin_users.role`'s own
 * `CHECK` (00-ARCHITECTURE.md §5.2, gap G1), **`maker` and `checker` cannot exist in
 * `admin_users` at all** — no bridge row can ever be created for those two roles, so no
 * authorised `ALTER` (forbidden here anyway, R1) or shadow-row scheme (option (b) in T-040's own
 * escalation) can ever close this for every recipient. Only option (c) — a `reward_portal`-owned
 * table with a real `portal_users` foreign key — closes it for all six roles, and it is exactly
 * the pattern this schema already uses twice for the identical reason: `portal_users` itself
 * (G1/G3) and `portal_user_credentials` (G2). This migration is the third application of that
 * same, already-reviewed pattern, not a new design decision.
 *
 * `reward_config.user_notifications` is left in place, untouched (R1) and unreferenced by this
 * module from this point on; nothing else in this codebase writes to it, so it is simply dead,
 * not migrated away from.
 *
 * ### Shape
 *
 * Column-for-column mirror of `reward_config.user_notifications` (confirmed live via `\d
 * reward_config.user_notifications`, not assumed from the extracted DDL), with two deliberate
 * differences:
 *
 *  1. `user_id` references `reward_portal.portal_users(id)` — the fix — `ON DELETE CASCADE`,
 *     because a notification has no meaning once its only reader is gone (unlike the `ON DELETE
 *     RESTRICT` convention 01-DATABASE.md §1 uses for the cross-schema anchors *to* `portal_users`;
 *     this FK points *from* a dependent row *to* `portal_users`, the same direction
 *     `portal_sessions.user_id` already takes with `CASCADE`).
 *  2. Two indexes the original table never had — implementation note 1's own instruction ("this
 *     table has no `deleted_at` and no per-user index by default, so add the filter explicitly
 *     and verify the query plan") is finally actionable now that the table is this task's own.
 *     `ix_pun_user_unread` serves `GET /notifications/unread-count`; `ix_pun_user_created` serves
 *     the paginated list's `ORDER BY created_at DESC, id DESC`.
 *
 * `tenant_id` keeps its cross-schema FK to `reward_config.tenants(id)`, `ON DELETE RESTRICT`,
 * matching 01-DATABASE.md §1's stated convention for every other such anchor in this schema.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_portal.portal_user_notifications (
          id                  int generated always as identity primary key,
          tenant_id           int           not null,
          user_id             int           not null,
          notification_type   varchar(30)   not null,
          title                varchar(200)  not null,
          message              varchar(500)  not null,
          entity_type          varchar(30)   null,
          entity_id            int           null,
          entity_label         varchar(200)  null,
          is_read              boolean       not null default false,
          read_at              timestamptz   null,
          created_at           timestamptz   not null default now(),

          constraint fk_pun_user foreign key (user_id)
              references reward_portal.portal_users(id) on delete cascade,
          constraint fk_pun_tenant foreign key (tenant_id)
              references reward_config.tenants(id) on delete restrict
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `CREATE INDEX ix_pun_user_unread
           ON reward_portal.portal_user_notifications(user_id, is_read);`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_pun_user_created
           ON reward_portal.portal_user_notifications(user_id, created_at desc, id desc);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** `CASCADE` drops the two indexes with the table; nothing else references this table. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_portal.portal_user_notifications CASCADE;', {
    type: QueryTypes.RAW,
  });
}
