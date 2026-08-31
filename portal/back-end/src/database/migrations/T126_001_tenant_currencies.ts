import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-126 — `reward_config.tenant_currencies` (13-REWARD-MASTER-VALUE-SOURCES.md §4).
 *
 * `countries.currency_code` is one currency per country — there is no way today for a tenant to
 * support more than one. This table is purely additive on top of it: `countries.currency_code`
 * stays exactly as it is (the country-level default, untouched by this migration), and a tenant
 * with no row here still has that default available, via the backfill below — never "blocked" by
 * an empty currency list, the same "additive, never a regression for an existing row" discipline
 * `tenant_budget_ceilings` (T-006) and `tracker_group_defs` (T-007) both already establish.
 *
 * `uq_tc_tenant_currency (tenant_id, currency_code)` — a tenant may list the same currency once.
 * `uq_tc_one_default`, a **partial** unique index (`WHERE is_default`) rather than a table-wide
 * constraint — the same shape `01-DATABASE.md`'s `campaign_caps`/`grpc_service_grants`
 * `dedupe_key`/`tenant_key` generated-column precedent uses (AR-02: "no minimum Postgres version
 * needed", CLAUDE.md's own record of that decision) — because a *non*-default row must be free to
 * repeat `is_default = false` across every currency a tenant lists; only the `true` value needs to
 * be unique per tenant.
 *
 * Backfill: one `is_default = true` row per existing, non-soft-deleted tenant
 * (`tenants.deleted_at IS NULL` — the same guard `T056_001`'s live-row indexes use), carrying that
 * tenant's own country's `currency_code`. This is what makes "a tenant with no extra rows still
 * has its country's currency available" true from the moment this migration lands, not only for
 * tenants created after it.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_config.tenant_currencies (
          id             int generated always as identity primary key,
          tenant_id      int          not null references reward_config.tenants(id),
          currency_code  char(3)      not null,
          is_default     boolean      not null default false,
          status         varchar(20)  not null default 'active',
          created_at     timestamptz  not null default now(),
          updated_at     timestamptz  not null default now(),

          constraint uq_tc_tenant_currency unique (tenant_id, currency_code),
          constraint ck_tc_status          check (status in ('active','inactive')),
          constraint ck_tc_currency_code   check (currency_code ~ '^[A-Z]{3}$')
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `CREATE UNIQUE INDEX uq_tc_one_default ON reward_config.tenant_currencies(tenant_id)
         WHERE is_default;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `CREATE INDEX ix_tc_tenant ON reward_config.tenant_currencies(tenant_id, status);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // Backfill (TC-1) — one default row per existing, live tenant, from its country's currency.
    await context.query(
      `INSERT INTO reward_config.tenant_currencies (tenant_id, currency_code, is_default, status)
       SELECT t2.id, c.currency_code, true, 'active'
       FROM reward_config.tenants t2
       JOIN reward_config.countries c ON c.id = t2.country_id
       WHERE t2.deleted_at IS NULL;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // `reward_app` needs an explicit GRANT on every reward_config table — no
    // ALTER DEFAULT PRIVILEGES here (T-091's own header explains why). Missing this in the same
    // migration that creates the table is the exact defect T-091 itself fixed once already.
    await context.query(
      `GRANT SELECT, INSERT, UPDATE ON reward_config.tenant_currencies TO reward_app;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `REVOKE SELECT, INSERT, UPDATE ON reward_config.tenant_currencies FROM reward_app;`,
      {
        type: QueryTypes.RAW,
        transaction: t,
      },
    );
    await context.query(`DROP TABLE IF EXISTS reward_config.tenant_currencies CASCADE;`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
