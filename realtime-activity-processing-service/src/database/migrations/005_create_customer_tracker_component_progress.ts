import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `customer_tracker_component_progress` — precomputed progress, the fast-read table
 * (01-DATABASE.md §4). FKs into `activity_logs` (004) via `last_activity_log_id` — created after
 * it, per this task's own implementation note 4.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE realtime_activity_processing.customer_tracker_component_progress (
      id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id                int NOT NULL,
      customer_id_hash         varchar(64) NOT NULL,
      campaign_code            varchar(50) NOT NULL,
      tracker_code             varchar(50) NOT NULL,
      tracker_component_code   varchar(50) NOT NULL,
      current_count            int NOT NULL DEFAULT 0,
      required_count           int NOT NULL,
      completion_cycle         int NOT NULL DEFAULT 1,
      is_completed             boolean NOT NULL DEFAULT false,
      completed_at             timestamptz NULL,
      last_activity_log_id     uuid NULL REFERENCES realtime_activity_processing.activity_logs(id),
      created_at               timestamptz NOT NULL DEFAULT now(),
      updated_at               timestamptz NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE UNIQUE INDEX uc_ctcp ON realtime_activity_processing.customer_tracker_component_progress
       (tenant_id, customer_id_hash, campaign_code, tracker_code, tracker_component_code, completion_cycle);`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `CREATE INDEX ix_ctcp_lookup ON realtime_activity_processing.customer_tracker_component_progress
       (tenant_id, customer_id_hash, campaign_code);`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    'DROP TABLE IF EXISTS realtime_activity_processing.customer_tracker_component_progress;',
    { type: QueryTypes.RAW },
  );
}
