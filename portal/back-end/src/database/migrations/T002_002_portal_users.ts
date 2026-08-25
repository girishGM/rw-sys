import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_portal.portal_users` — verbatim from 01-DATABASE.md §2.1. Closes gaps G1
 * (maker/checker unrepresentable in `admin_users`) and G3 (api-key coupling).
 *
 * `ck_portal_users_scope` is the single most important constraint in this migration — it
 * makes a mis-scoped user physically unstorable (01-DATABASE.md's own words). Do not
 * simplify it.
 *
 * Deviation from the doc's first draft (fixed 2026-08-15, found by running TC-8 for
 * real): the doc originally also specified a plain `unique (email)` table constraint
 * alongside the partial `uq_portal_users_email_live` index below. The two contradict each
 * other — the partial index exists specifically so a soft-deleted user's email becomes
 * reusable, which the plain constraint silently prevented. Removed; see 01-DATABASE.md
 * §2.1 for the full account.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_portal.portal_users (
          id                  int generated always as identity primary key,
          email               varchar(200)  not null,
          display_name        varchar(100)  not null,
          role                varchar(20)   not null,
          country_id          int           null,
          tenant_id           int           null,
          merchant_id         int           null,
          admin_user_id       int           null,
          preferred_timezone  varchar(60)   null,
          preferred_locale    varchar(10)   null    default 'en',
          status              varchar(20)   not null default 'pending_activation',
          must_change_password boolean      not null default true,
          mfa_enabled         boolean       not null default false,
          mfa_secret_enc      varchar(512)  null,
          created_by          int           null references reward_portal.portal_users(id),
          last_login_at       timestamptz   null,
          created_at          timestamptz   not null default now(),
          updated_at          timestamptz   not null default now(),
          deleted_at          timestamptz   null,

          constraint ck_portal_users_role check (role in
              ('super_admin','country_admin','tenant_admin','maker','checker','merchant')),
          constraint ck_portal_users_status check (status in
              ('pending_activation','active','inactive','locked','suspended')),
          constraint fk_portal_users_country  foreign key (country_id)
              references reward_config.countries(id)  on delete restrict,
          constraint fk_portal_users_tenant   foreign key (tenant_id)
              references reward_config.tenants(id)    on delete restrict,
          constraint fk_portal_users_merchant foreign key (merchant_id)
              references reward_config.merchants(id)  on delete restrict,

          constraint ck_portal_users_scope check (
              (role = 'super_admin'   and country_id is null and tenant_id is null and merchant_id is null) or
              (role = 'country_admin' and country_id is not null and tenant_id is null and merchant_id is null) or
              (role in ('tenant_admin','maker','checker')
                                      and country_id is not null and tenant_id is not null and merchant_id is null) or
              (role = 'merchant'      and country_id is not null and tenant_id is not null and merchant_id is not null)
          )
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `CREATE INDEX ix_portal_users_role ON reward_portal.portal_users(role) WHERE deleted_at IS NULL;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_portal_users_tenant ON reward_portal.portal_users(tenant_id) WHERE deleted_at IS NULL;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_portal_users_country ON reward_portal.portal_users(country_id) WHERE deleted_at IS NULL;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE UNIQUE INDEX uq_portal_users_email_live
          ON reward_portal.portal_users(lower(email)) WHERE deleted_at IS NULL;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_portal.portal_users CASCADE;', {
    type: QueryTypes.RAW,
  });
}
