import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `customer_reward_limit_consumption` — per-customer reward-limit consumption tracking,
 * 01-DATABASE.md §6, same reserve-then-commit discipline as `budget_consumption` (007).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE realtime_activity_processing.customer_reward_limit_consumption (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id             int NOT NULL,
      customer_id_hash      varchar(64) NOT NULL,
      campaign_code         varchar(50) NOT NULL,
      reward_policy_code    varchar(80) NOT NULL,
      assignment_level      varchar(20) NOT NULL CHECK (assignment_level IN ('component','tracker','campaign')),
      period_start          timestamptz NOT NULL,
      period_end            timestamptz NOT NULL,
      consumed_amount       decimal(18,4) NOT NULL DEFAULT 0,
      consumed_count        int NOT NULL DEFAULT 0,
      updated_at            timestamptz NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE UNIQUE INDEX uc_customer_reward_limit ON realtime_activity_processing.customer_reward_limit_consumption
       (tenant_id, customer_id_hash, campaign_code, reward_policy_code, assignment_level, period_start);`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    'DROP TABLE IF EXISTS realtime_activity_processing.customer_reward_limit_consumption;',
    { type: QueryTypes.RAW },
  );
}
