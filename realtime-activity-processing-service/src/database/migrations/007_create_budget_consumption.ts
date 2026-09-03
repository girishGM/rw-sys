import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `budget_consumption` — campaign-scope budget cap consumption tracking, 01-DATABASE.md §6. This
 * service is the only place that tracks actual real-time consumption against the portal's
 * cached, read-only `CampaignCap` definitions.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE realtime_activity_processing.budget_consumption (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id             int NOT NULL,
      campaign_code         varchar(50) NOT NULL,
      reward_policy_code    varchar(80) NOT NULL,
      cap_type              varchar(30) NOT NULL,
      period_start          timestamptz NOT NULL,
      period_end            timestamptz NOT NULL,
      consumed_amount       decimal(18,4) NOT NULL DEFAULT 0,
      consumed_count        int NOT NULL DEFAULT 0,
      updated_at            timestamptz NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE UNIQUE INDEX uc_budget_consumption ON realtime_activity_processing.budget_consumption
       (tenant_id, campaign_code, reward_policy_code, cap_type, period_start);`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS realtime_activity_processing.budget_consumption;', {
    type: QueryTypes.RAW,
  });
}
