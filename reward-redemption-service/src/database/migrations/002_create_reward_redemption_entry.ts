import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_redemption_entry` — the inbound ledger, `01-DATABASE.md` §1. Copied verbatim from that
 * DDL, including the deliberate absence of a `DEFAULT` on `id` (T-RR-002 note 3): the primary key
 * on the caller-supplied id is the entire idempotency mechanism (R6, `ARCHITECTURE.md` §7) — a
 * second insert of the same id must raise `23505`, not silently succeed.
 *
 * `ix_rre_status_next_attempt` is the claim worker's own scan index
 * (`05-PROCESSING-PIPELINE.md` §3) — partial on `status IN ('received','retrying')`, ordered
 * `(status, next_attempt_at, created_at)` so the claim query's own `WHERE status IN
 * ('received','retrying') AND (next_attempt_at IS NULL OR next_attempt_at <= now()) ORDER BY
 * created_at ... LIMIT 1` can use it directly.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_redemption.reward_redemption_entry (
      id                          uuid            PRIMARY KEY,
      correlation_id              uuid            NOT NULL,
      tenant_id                   int             NOT NULL,
      customer_id_encrypted       text            NOT NULL,
      customer_id_hash            varchar(64)     NOT NULL,
      customer_id_type            varchar(30)     NOT NULL,
      activity_performed_date     timestamptz     NOT NULL,
      transaction_type            varchar(50)     NULL,
      activity_code               varchar(50)     NULL,
      activity_type               varchar(50)     NOT NULL,
      activity_category           varchar(50)     NOT NULL,
      activity_value              decimal(18,4)   NOT NULL,
      activity_value_unit         varchar(10)     NOT NULL,
      channel                     varchar(30)     NOT NULL,
      activity_performed_env      varchar(30)     NOT NULL,
      activity_name               varchar(200)    NOT NULL,
      campaign_code               varchar(50)     NOT NULL,
      tracker_code                varchar(50)     NOT NULL,
      tracker_component_code      varchar(50)     NOT NULL,
      merchant_code               varchar(50)     NULL,
      reward_code                 varchar(80)     NOT NULL,
      reward_category             varchar(50)     NOT NULL,
      reward_value                decimal(18,4)   NOT NULL,
      reward_value_unit           varchar(10)     NOT NULL,
      reward_entry_date           timestamptz     NOT NULL,
      completion_cycle            int             NOT NULL DEFAULT 1,
      reward_processed_env        varchar(30)     NOT NULL,
      country_code                char(2)         NULL,
      tenant_code                 varchar(20)     NULL,
      ingestion_channel           varchar(10)     NOT NULL,
      status                      varchar(20)     NOT NULL DEFAULT 'received',
      retry_count                 int             NOT NULL DEFAULT 0,
      next_attempt_at             timestamptz     NULL,
      last_error_code             varchar(50)     NULL,
      last_error_message          text            NULL,
      last_attempted_at           timestamptz     NULL,
      external_system_code        varchar(50)     NULL,
      external_reference_id       varchar(200)    NULL,
      redeemed_at                 timestamptz     NULL,
      created_at                  timestamptz     NOT NULL DEFAULT now(),
      updated_at                  timestamptz     NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE INDEX ix_rre_status_next_attempt ON reward_redemption.reward_redemption_entry (status, next_attempt_at, created_at)
       WHERE status IN ('received', 'retrying');`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `CREATE INDEX ix_rre_tenant_campaign ON reward_redemption.reward_redemption_entry (tenant_id, campaign_code);`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `CREATE INDEX ix_rre_customer_hash ON reward_redemption.reward_redemption_entry (customer_id_hash);`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_redemption.reward_redemption_entry;', {
    type: QueryTypes.RAW,
  });
}
