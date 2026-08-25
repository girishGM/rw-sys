import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_config.campaign_caps` — verbatim from 11-BUDGETS-AND-LIMITS.md §2. This is the
 * table the schema was missing entirely: nothing anywhere says whether a cap is **pooled**
 * across all customers (`cap_class = 'budget'`) or applies to **each customer**
 * individually (`cap_class = 'limit'`) — G17 in progress.json. Every CHECK constraint below
 * is load-bearing (task file, Implementation notes §1): this table is written by a wizard
 * (T-037) and read by an external transaction runtime that pays real money against it, so a
 * malformed row must be structurally impossible, not merely discouraged.
 *
 * - `ck_cc_unit` — an amount cap with no unit is meaningless and would be silently
 *   misread by the runtime.
 * - `ck_cc_unit_type` — the only three payout units this design recognises
 *   (11-BUDGETS-AND-LIMITS.md §3.1); there is deliberately no conversion rate anywhere.
 * - `ck_cc_has_ceiling` — a cap row that caps nothing is a configuration error, not data.
 * - `ck_cc_rolling` / `ck_cc_window` — period parameters must match the period type.
 * - `ck_cc_customers` — `max_customers` is a pooled idea; nonsense per-customer.
 * - `ck_cc_ref` — campaign scope has no ref id; tracker/component scope must have one.
 *
 * `dedupe_key` is a **generated column**, not a CHECK, but equally load-bearing (AR-02,
 * revised 2026-08-14 once Postgres was confirmed as the production target — see
 * `CAPABILITY-COMPARISON.md` CC-00). `scope_ref_id`, `period_value`, `window_start_time`,
 * `unit_type`, `unit_code` and `reward_type` are all nullable, and the single most common
 * row shape — a campaign-level, lifetime, all-reward-types budget — has most of them NULL.
 * Postgres treats every NULL as distinct, so a plain UNIQUE constraint over those columns
 * enforces nothing for that shape (TC-50). `GENERATED ALWAYS AS (...) STORED` normalises
 * the nullable discriminators into one comparable string so `uq_cc_unique` actually keys on
 * what the row means, without disturbing any other CHECK constraint's own NULL semantics
 * and without a Postgres-15-only `NULLS NOT DISTINCT` clause.
 *
 * `period_timezone` has no static `DEFAULT` (Postgres column defaults cannot see another
 * column's value), so `trg_cc_default_timezone` fills it in from the campaign's own
 * country's `countries.timezone` on INSERT when the caller omits it (Implementation
 * notes §3, TC-32) — a Malaysian daily budget must reset at midnight Kuala Lumpur, not UTC.
 *
 * No `ON DELETE CASCADE` from `tenant_campaigns` (Implementation notes §6): campaigns are
 * soft-deleted (`tenant_campaigns.deleted_at`), never hard-deleted, so cap rows always
 * survive with them (TC-33) — there is nothing here to cascade from in the first place.
 *
 * `window_start_time` / `window_end_time` are time-of-day only. A window crossing midnight
 * (e.g. 22:00–02:00) is a legal row and means "22:00 today to 02:00 the next day"
 * (Implementation notes §5, TC-30) — the database does not interpret this arithmetically;
 * a naive `BETWEEN` comparison on it returns nothing for that range, so any consumer
 * evaluating a time-of-day window must special-case `window_end_time < window_start_time`
 * as "wraps past midnight" rather than treating the two times as a plain range.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_config.campaign_caps (
          id                int generated always as identity primary key,
          tenant_id         int          not null,
          campaign_id       int          not null references reward_config.tenant_campaigns(id),

          cap_class         varchar(10)  not null,
          scope_level       varchar(12)  not null,
          scope_ref_id      int          null,

          period_type       varchar(16)  not null,
          period_value      int          null,
          window_start_time time         null,
          window_end_time   time         null,
          period_timezone   varchar(60)  null,

          unit_type         varchar(14)  null,
          unit_code         varchar(10)  null,
          reward_type       varchar(30)  null,

          max_total_amount  decimal(18,4) null,
          max_occurrences   int           null,
          max_customers     int           null,

          on_breach         varchar(16)  not null default 'reject',
          warn_at_percent   int          null,

          status            varchar(20)  not null default 'active',
          created_by        int          not null,
          created_at        timestamptz  not null default now(),
          updated_at        timestamptz  not null default now(),

          constraint ck_cc_class  check (cap_class in ('budget','limit')),
          constraint ck_cc_scope  check (scope_level in ('campaign','tracker','component')),
          constraint ck_cc_period check (period_type in
              ('lifetime','daily','monthly','rolling_hours','time_of_day')),
          constraint ck_cc_breach check (on_breach in ('reject','pause_campaign','alert_only')),

          constraint ck_cc_unit
              check (max_total_amount is null or (unit_type is not null and unit_code is not null)),
          constraint ck_cc_unit_type
              check (unit_type is null or unit_type in ('currency','points','voucher')),
          constraint ck_cc_has_ceiling
              check (max_total_amount is not null
                  or max_occurrences  is not null
                  or max_customers    is not null),
          constraint ck_cc_rolling
              check (period_type <> 'rolling_hours' or period_value is not null),
          constraint ck_cc_window
              check (period_type <> 'time_of_day'
                  or (window_start_time is not null and window_end_time is not null)),
          constraint ck_cc_customers
              check (max_customers is null or cap_class = 'budget'),
          constraint ck_cc_ref
              check ((scope_level = 'campaign' and scope_ref_id is null)
                  or (scope_level <> 'campaign' and scope_ref_id is not null)),

          dedupe_key varchar(160) generated always as (
              coalesce(scope_ref_id::text, '') || '|' ||
              coalesce(period_value::text, '')  || '|' ||
              coalesce(window_start_time::text, '') || '|' ||
              coalesce(unit_type, '') || '|' ||
              coalesce(unit_code, '') || '|' ||
              coalesce(reward_type, '')
          ) stored,

          constraint uq_cc_unique unique
              (campaign_id, cap_class, scope_level, period_type, dedupe_key)
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_cc_campaign ON reward_config.campaign_caps(campaign_id, status);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // period_timezone default — see this file's own doc comment above. Only fires when the
    // caller omits it; an explicit value (including a deliberately different timezone) is
    // always respected.
    await context.query(
      `
      CREATE FUNCTION reward_config.fn_cc_default_timezone() RETURNS trigger AS $$
      BEGIN
        IF NEW.period_timezone IS NULL THEN
          SELECT co.timezone INTO NEW.period_timezone
            FROM reward_config.tenant_campaigns tc
            JOIN reward_config.tenants  t  ON t.id  = tc.tenant_id
            JOIN reward_config.countries co ON co.id = t.country_id
           WHERE tc.id = NEW.campaign_id;
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      `,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE TRIGGER trg_cc_default_timezone
           BEFORE INSERT ON reward_config.campaign_caps
           FOR EACH ROW EXECUTE FUNCTION reward_config.fn_cc_default_timezone();`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** Trigger and function first (they depend on the table), then the table itself. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `DROP TRIGGER IF EXISTS trg_cc_default_timezone ON reward_config.campaign_caps;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(`DROP FUNCTION IF EXISTS reward_config.fn_cc_default_timezone();`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await context.query(`DROP TABLE IF EXISTS reward_config.campaign_caps CASCADE;`, {
      type: QueryTypes.RAW,
      transaction: t,
    });

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
