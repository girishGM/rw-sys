import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `customer_tracker_status` — tracker-level completion aggregate (01-DATABASE.md §5).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE realtime_activity_processing.customer_tracker_status (
      id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id                 int NOT NULL,
      customer_id_hash          varchar(64) NOT NULL,
      campaign_code             varchar(50) NOT NULL,
      tracker_code              varchar(50) NOT NULL,
      completion_cycle          int NOT NULL DEFAULT 1,
      components_required_count int NOT NULL,
      components_completed_count int NOT NULL DEFAULT 0,
      is_completed              boolean NOT NULL DEFAULT false,
      completed_at              timestamptz NULL,
      created_at                timestamptz NOT NULL DEFAULT now(),
      updated_at                timestamptz NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE UNIQUE INDEX uc_cts ON realtime_activity_processing.customer_tracker_status
       (tenant_id, customer_id_hash, campaign_code, tracker_code, completion_cycle);`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    'DROP TABLE IF EXISTS realtime_activity_processing.customer_tracker_status;',
    { type: QueryTypes.RAW },
  );
}
