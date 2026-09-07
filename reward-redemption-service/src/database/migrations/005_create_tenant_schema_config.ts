import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `tenant_schema_config` — dynamic per-tenant/country/environment schema routing
 * (`01-DATABASE.md` §4). Modeled on `reward_config.service_schema_mappings` plus the two axes
 * that frozen table is missing (`country_code`, `environment`) — this plan cannot add columns to
 * another service's schema (R5), so this table caches the equivalent mapping locally instead.
 *
 * **v1 reality** (`ARCHITECTURE.md` §10): every seed row here points at this service's own single
 * `reward_redemption` schema — there is no real schema split live yet anywhere in this repo — but
 * every later lookup goes through this table (and its cache, T-RR-007), never a hardcoded
 * connection string, so a real per-tenant split later is a data change, not a code change.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_redemption.tenant_schema_config (
      id              int          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tenant_id       int          NOT NULL,
      tenant_code     varchar(20)  NOT NULL,
      country_code    char(2)      NOT NULL,
      environment     varchar(20)  NOT NULL,
      database_name   varchar(100) NOT NULL,
      schema_name     varchar(50)  NOT NULL,
      is_active       boolean      NOT NULL DEFAULT true,
      created_at      timestamptz  NOT NULL DEFAULT now(),
      updated_at      timestamptz  NOT NULL DEFAULT now(),
      CONSTRAINT uq_tsc_tenant_country_env UNIQUE (tenant_id, country_code, environment)
    );`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_redemption.tenant_schema_config;', {
    type: QueryTypes.RAW,
  });
}
