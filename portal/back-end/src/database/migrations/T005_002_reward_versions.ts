import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_config.reward_versions` — mirrors `rule_versions` exactly (06-VERSIONING.md §5
 * says so explicitly: "full DDL in the T-005 task file"), with the frozen payload being
 * the reward-specific fields the task file's own "Implementation notes" §0/§1 name:
 * `connector_config` (holds third-party secrets — encrypted per
 * 07-DATA-PROTECTION.md, enforcement lands in T-017; this table only shapes the column),
 * `delivery_mode`, `retry_config` and a `policies_snapshot` JSON of the policy set at
 * publish time.
 *
 * `unit_type` / `unit_code` are the payout unit (11-BUDGETS-AND-LIMITS.md §3.1) —
 * `currency|points|voucher` and a code such as `MYR`/`PTS`/a voucher pool code. There is
 * no conversion rate anywhere in the design; a budget only ever matches a grant that
 * shares both fields exactly (T-006 adds the mirroring columns to `campaign_caps`).
 *
 * Naming deliberately uses an `rewv_`/`rv_` split from the rule-side `rv_` prefix (e.g.
 * `uq_rewv_one_draft` vs `uq_rv_one_draft`) so the two tables' constraint/index names
 * never collide in `pg_catalog` or in error messages an operator has to read at 3am.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_config.reward_versions (
          id                    int generated always as identity primary key,
          reward_id             int          not null references reward_config.reward_systems(id),
          version_no            int          not null,
          connector_config      text         null,
          delivery_mode         varchar(20)  null,
          retry_config          text         null,
          policies_snapshot     jsonb        null,
          unit_type             varchar(14)  null,
          unit_code             varchar(10)  null,
          change_summary        varchar(500) null,
          is_breaking           boolean      not null default false,
          status                varchar(20)  not null default 'draft',
          supersedes_version_id int          null references reward_config.reward_versions(id),
          origin_request_id     int          null,
          created_by            int          not null,
          created_at            timestamptz  not null default now(),
          published_by          int          null,
          published_at          timestamptz  null,
          deprecated_at         timestamptz  null,
          retired_at            timestamptz  null,
          updated_at            timestamptz  not null default now(),
          constraint uq_rewv_reward_version unique (reward_id, version_no),
          constraint ck_rewv_status check (status in ('draft','published','deprecated','retired')),
          constraint ck_rewv_published_fields
              check (status = 'draft' or (published_at is not null and published_by is not null)),
          constraint ck_rewv_unit_type
              check (unit_type is null or unit_type in ('currency','points','voucher'))
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_rewv_reward_status ON reward_config.reward_versions(reward_id, status);`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE UNIQUE INDEX uq_rewv_one_draft
           ON reward_config.reward_versions(reward_id) WHERE status = 'draft';`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_config.reward_versions CASCADE;', {
    type: QueryTypes.RAW,
  });
}
