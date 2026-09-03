import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `field_encryption_config` — which fields get encrypted in logs, confirmed configurable
 * (01-DATABASE.md §10). Seeded with exactly one row by T-RAP-003
 * (`('global', NULL, 'customerId', true)`) — this migration only creates the table shape.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE realtime_activity_processing.field_encryption_config (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scope_level    varchar(20) NOT NULL DEFAULT 'global' CHECK (scope_level IN ('global','country','tenant','campaign')),
      scope_ref      varchar(50) NULL,
      field_name     varchar(80) NOT NULL,
      is_encrypted   boolean NOT NULL DEFAULT true,
      added_at       timestamptz NOT NULL DEFAULT now(),
      added_by       varchar(100) NOT NULL
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE UNIQUE INDEX uc_field_encryption_config ON realtime_activity_processing.field_encryption_config (scope_level, scope_ref, field_name);`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    'DROP TABLE IF EXISTS realtime_activity_processing.field_encryption_config;',
    { type: QueryTypes.RAW },
  );
}
