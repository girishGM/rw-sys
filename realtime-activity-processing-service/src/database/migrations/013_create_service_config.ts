import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `service_config` — general per-scope configuration, mirroring `reward_config.system_configs`'s
 * own `(config_key, scope, scope_identifier)` shape, extended with two extra scope levels
 * (01-DATABASE.md §11). Examples are seeded by T-RAP-003 — this migration only creates the shape.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE realtime_activity_processing.service_config (
      id                int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      config_key        varchar(100) NOT NULL,
      config_value      text NOT NULL,
      scope_level       varchar(20) NOT NULL DEFAULT 'global' CHECK (scope_level IN ('global','country','tenant','campaign')),
      scope_ref         varchar(50) NULL,
      description       varchar(500) NULL,
      updated_at        timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_service_config_key_scope UNIQUE (config_key, scope_level, scope_ref)
    );`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS realtime_activity_processing.service_config;', {
    type: QueryTypes.RAW,
  });
}
