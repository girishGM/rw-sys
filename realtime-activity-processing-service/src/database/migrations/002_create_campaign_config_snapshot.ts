import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `campaign_config_snapshot` — the cold cache, 01-DATABASE.md §1. Copied verbatim: the local,
 * durable mirror of whatever the portal's bulk gRPC endpoint last returned for one campaign.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE realtime_activity_processing.campaign_config_snapshot (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id         int NOT NULL,
      campaign_code     varchar(50) NOT NULL,
      config_version    varchar(64) NOT NULL,
      is_active         boolean NOT NULL,
      payload           jsonb NOT NULL,
      fetched_at        timestamptz NOT NULL DEFAULT now(),
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE UNIQUE INDEX uc_campaign_config_snapshot ON realtime_activity_processing.campaign_config_snapshot (tenant_id, campaign_code);`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `CREATE INDEX ix_campaign_config_snapshot_active ON realtime_activity_processing.campaign_config_snapshot (is_active) WHERE is_active;`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    'DROP TABLE IF EXISTS realtime_activity_processing.campaign_config_snapshot;',
    { type: QueryTypes.RAW },
  );
}
