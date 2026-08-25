import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_config.tenant_budget_ceilings` — verbatim from 11-BUDGETS-AND-LIMITS.md §8.2, the
 * "typo guard" (G18 in progress.json). Today the only thing between a mistyped
 * `MYR 5,000,000` and an approved campaign is a checker noticing; this table turns that
 * judgement call into a structural impossibility at submit time (enforced in T-034/T-037's
 * `POST /campaigns/:id/submit`, not here — this task only shapes and constrains the data).
 *
 * Per unit (§8.1/§8.2, same reasoning as `campaign_caps.unit_type`/`unit_code`, §3.1): a
 * tenant may have a MYR ceiling and a separate PTS ceiling, never one number governing both.
 *
 * `ck_tbc_warn` is the one constraint worth calling out: a `warn_above_amount` set above
 * `max_campaign_budget` could never fire, so it is rejected at write time rather than left
 * as a silently-dead value someone has to notice is wrong.
 *
 * **No ceiling row for a tenant means unlimited, not blocked** (Implementation notes §9,
 * §8.5) — this table is deliberately never backfilled by this migration. Surfacing the gap
 * is a Country Admin dashboard widget (T-034), not a default row inserted here.
 *
 * Set only by `country_admin` (§8.3) — enforced by the permission matrix (T-013/T-033), not
 * a DB-level actor check; `created_by` here is an opaque actor id, same convention as every
 * other `created_by int not null` column in this schema.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_config.tenant_budget_ceilings (
          id                    int generated always as identity primary key,
          tenant_id             int          not null references reward_config.tenants(id),

          unit_type             varchar(14)  not null,
          unit_code             varchar(10)  not null,

          max_campaign_budget   decimal(18,4) not null,
          warn_above_amount     decimal(18,4) null,

          status                varchar(20)  not null default 'active',
          created_by            int          not null,
          created_at            timestamptz  not null default now(),
          updated_at            timestamptz  not null default now(),

          constraint uq_tbc unique (tenant_id, unit_type, unit_code),
          constraint ck_tbc_unit     check (unit_type in ('currency','points','voucher')),
          constraint ck_tbc_positive check (max_campaign_budget > 0),
          constraint ck_tbc_warn     check (warn_above_amount is null
                                          or warn_above_amount <= max_campaign_budget)
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_tbc_tenant ON reward_config.tenant_budget_ceilings(tenant_id, status);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_config.tenant_budget_ceilings CASCADE;', {
    type: QueryTypes.RAW,
  });
}
