import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `activity_logs` — the fan-out ledger, the core table (01-DATABASE.md §3). Created before
 * `customer_tracker_component_progress` (§4), which FKs into it via `last_activity_log_id`
 * (this task's own implementation note 4). `uc_activity_logs_fanout` is the idempotency backstop
 * TC-3/verification-step-4 exercises: the same source activity can never create two rows for the
 * same (campaign, tracker, component) combination, no matter how many times it is redelivered.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE realtime_activity_processing.activity_logs (
      id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      correlation_id           uuid NOT NULL,
      dedup_key                varchar(128) NOT NULL,
      tenant_id                int NOT NULL,
      customer_id_encrypted    text NOT NULL,
      customer_id_hash         varchar(64) NOT NULL,
      customer_id_type         varchar(30) NOT NULL,
      activity_performed_date  timestamptz NOT NULL,
      transaction_type         varchar(50) NULL,
      activity_code            varchar(50) NULL,
      activity_type            varchar(50) NOT NULL,
      activity_category        varchar(50) NOT NULL,
      activity_value           decimal(18,4) NOT NULL,
      activity_value_unit      varchar(10) NOT NULL,
      channel                  varchar(30) NOT NULL,
      activity_performed_env   varchar(30) NOT NULL,
      activity_name            varchar(200) NOT NULL,
      campaign_code            varchar(50) NOT NULL,
      tracker_code             varchar(50) NOT NULL,
      tracker_component_code   varchar(50) NOT NULL,
      merchant_code            varchar(50) NULL,
      source_transport         varchar(10) NOT NULL CHECK (source_transport IN ('KAFKA','GRPC')),
      activity_reached_date    timestamptz NOT NULL DEFAULT now(),
      activity_processed_date  timestamptz NULL,
      status                   varchar(20) NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','processing','processed','error','skipped_duplicate')),
      error_code               varchar(50) NULL,
      comment                  varchar(1000) NULL,
      created_at               timestamptz NOT NULL DEFAULT now(),
      updated_at               timestamptz NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE UNIQUE INDEX uc_activity_logs_fanout
       ON realtime_activity_processing.activity_logs (dedup_key, campaign_code, tracker_code, tracker_component_code);`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `CREATE INDEX ix_activity_logs_pending ON realtime_activity_processing.activity_logs (status, activity_reached_date) WHERE status = 'pending';`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `CREATE INDEX ix_activity_logs_customer ON realtime_activity_processing.activity_logs (tenant_id, customer_id_hash, campaign_code);`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `CREATE INDEX ix_activity_logs_correlation ON realtime_activity_processing.activity_logs (correlation_id);`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS realtime_activity_processing.activity_logs;', {
    type: QueryTypes.RAW,
  });
}
