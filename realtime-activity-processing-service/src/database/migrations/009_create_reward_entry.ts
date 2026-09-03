import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_entry` — one row per earned reward, 01-DATABASE.md §7. Created before
 * `reward_entry_outbox` (010) and `reward_dispatch_retry` (011), both of which FK into it
 * (this task's own implementation note 4). `uc_reward_entry_completion` is the idempotency
 * backstop TC-4/verification-step-4 exercises: exactly one reward per customer per
 * tracker-component completion cycle. `dispatch_status` tracks delivery only — R3: never
 * rolled back or deleted because a downstream delivery attempt failed.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE realtime_activity_processing.reward_entry (
      id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      correlation_id            uuid NOT NULL,
      tenant_id                 int NOT NULL,
      customer_id_encrypted     text NOT NULL,
      customer_id_hash          varchar(64) NOT NULL,
      customer_id_type          varchar(30) NOT NULL,
      activity_performed_date   timestamptz NOT NULL,
      transaction_type          varchar(50) NULL,
      activity_code             varchar(50) NULL,
      activity_type             varchar(50) NOT NULL,
      activity_category         varchar(50) NOT NULL,
      activity_value            decimal(18,4) NOT NULL,
      activity_value_unit       varchar(10) NOT NULL,
      channel                   varchar(30) NOT NULL,
      activity_performed_env    varchar(30) NOT NULL,
      activity_name             varchar(200) NOT NULL,
      campaign_code             varchar(50) NOT NULL,
      tracker_code              varchar(50) NOT NULL,
      tracker_component_code    varchar(50) NOT NULL,
      merchant_code             varchar(50) NULL,
      reward_code               varchar(80) NOT NULL,
      reward_category           varchar(50) NOT NULL,
      reward_value              decimal(18,4) NOT NULL,
      reward_value_unit         varchar(10) NOT NULL,
      reward_entry_date         timestamptz NOT NULL DEFAULT now(),
      completion_cycle          int NOT NULL DEFAULT 1,
      dispatch_status           varchar(20) NOT NULL DEFAULT 'pending'
                                   CHECK (dispatch_status IN ('pending','dispatched','failed')),
      dispatch_attempts         int NOT NULL DEFAULT 0,
      last_dispatch_error       text NULL,
      created_at                timestamptz NOT NULL DEFAULT now(),
      updated_at                timestamptz NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE UNIQUE INDEX uc_reward_entry_completion ON realtime_activity_processing.reward_entry
       (tenant_id, customer_id_hash, campaign_code, tracker_code, tracker_component_code, completion_cycle);`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `CREATE INDEX ix_reward_entry_dispatch_pending ON realtime_activity_processing.reward_entry (dispatch_status) WHERE dispatch_status = 'pending';`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS realtime_activity_processing.reward_entry;', {
    type: QueryTypes.RAW,
  });
}
