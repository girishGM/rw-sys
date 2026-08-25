import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_portal.portal_approval_requests` — T-037, resolving the **fourth** instance of the
 * `admin_users` foreign-key gap, and the one that would otherwise make campaign submission
 * impossible rather than merely lossy.
 *
 * ### The gap, confirmed live before this file was written
 *
 * `reward_config.approval_requests.requested_by` is `int NOT NULL` carrying
 * `fk_ar_requested_by → reward_config.admin_users(id)` (confirmed via `pg_constraint` against the
 * live database, not assumed from the extracted DDL). `reviewed_by` carries the mirror FK. But
 * `ck_admin_users_role` permits only `super_admin`, `country_admin`, `tenant_admin`, `merchant` —
 * **`maker` and `checker` cannot exist in `admin_users` at all** (00-ARCHITECTURE.md §5.2, gap
 * G1), and `admin_users.api_key_id` is `NOT NULL UNIQUE` besides (gap G3). Those two roles are
 * precisely the ones that submit and approve campaigns.
 *
 * So the row `POST /campaigns/:id/submit` must write is not merely unattributable — it is
 * **uninsertable**. Every submission would fail on a foreign key, and the segregation-of-duty
 * control T-038 is built on (`requested_by === actor.id` → 422 `SELF_APPROVAL_FORBIDDEN`) would
 * be comparing a portal user id against a column that structurally cannot hold one.
 *
 * ### Why a new table, and why this is not a new design decision
 *
 * This is the same escalation T-014 first raised for `campaign_audit_trail.performed_by`, and the
 * same one T-040's first review failed on for `user_notifications.user_id`. That escalation was
 * resolved, by the architect, with option (c): a `reward_portal`-owned table whose actor columns
 * reference `reward_portal.portal_users(id)` directly — see
 * `T040_001_portal_user_notifications.ts`'s own header. `reward_config.approval_requests` cannot
 * be altered (R1) and no bridge row can ever be created for `maker`/`checker`, so options (a) and
 * (b) are closed here for exactly the reasons they were closed there. This migration is the
 * fourth application of a pattern this schema already uses for `portal_users` itself (G1/G3),
 * `portal_user_credentials` (G2) and `portal_user_notifications` (T-040).
 *
 * `reward_config.approval_requests` is left in place and untouched (R1). It holds zero rows on
 * this database and nothing in the portal writes to it.
 *
 * ### Shape
 *
 * Column-for-column mirror of the live `reward_config.approval_requests`, with four deliberate
 * differences:
 *
 *  1. `requested_by` / `reviewed_by` reference `reward_portal.portal_users(id)` — the fix.
 *     `ON DELETE RESTRICT`: an approval request is governance evidence and must not disappear
 *     because an account was removed.
 *  2. `ck_par_status` gains **`returned`** alongside the original five. The original already had
 *     it; it is restated here so the vocabulary is pinned by this schema rather than inherited.
 *  3. `payload` is `jsonb`, not `text`. The original predates the portal's `jsonb` convention;
 *     nothing reads the legacy column, and a checker's diff view (T-038) is far better served by
 *     a type the database can index and validate than by a string that might not parse.
 *  4. Two indexes the original lacks: the checker's queue (`tenant_id, status, requested_at`) and
 *     the campaign lookup (`entity_type, entity_id`), which `GET /campaigns/:id` performs on
 *     every read.
 *
 * `tenant_id` keeps a cross-schema FK to `reward_config.tenants(id)` `ON DELETE RESTRICT`,
 * matching 01-DATABASE.md §1's stated convention for every other such anchor.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_portal.portal_approval_requests (
          id              int generated always as identity primary key,
          tenant_id       int           not null,
          entity_type     varchar(50)   not null,
          entity_id       int           null,
          action          varchar(20)   not null,
          status          varchar(20)   not null default 'pending',
          payload         jsonb         null,
          requested_by    int           not null,
          requested_at    timestamptz   not null default now(),
          reviewed_by     int           null,
          reviewed_at     timestamptz   null,
          review_comment  varchar(500)  null,
          expires_at      timestamptz   not null,
          created_at      timestamptz   not null default now(),
          updated_at      timestamptz   not null default now(),

          constraint ck_par_status check (status in
              ('pending','approved','rejected','expired','returned')),
          constraint ck_par_action check (action in ('create','update','delete')),
          constraint fk_par_tenant foreign key (tenant_id)
              references reward_config.tenants(id) on delete restrict,
          constraint fk_par_requested_by foreign key (requested_by)
              references reward_portal.portal_users(id) on delete restrict,
          constraint fk_par_reviewed_by foreign key (reviewed_by)
              references reward_portal.portal_users(id) on delete restrict
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `CREATE INDEX ix_par_queue
           ON reward_portal.portal_approval_requests(tenant_id, status, requested_at desc);`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_par_entity
           ON reward_portal.portal_approval_requests(entity_type, entity_id);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** `CASCADE` drops the two indexes with the table. `T037_002`'s own FK to this table is dropped
 * first by that migration's `down()`, which runs before this one. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_portal.portal_approval_requests CASCADE;', {
    type: QueryTypes.RAW,
  });
}
