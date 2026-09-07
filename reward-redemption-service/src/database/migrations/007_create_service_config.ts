import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `service_config` — general scoped configuration (campaign → tenant → country → global),
 * `01-DATABASE.md` §6. Reuses RAP's own `01-DATABASE.md` §11 shape and precedence order exactly —
 * every configurable numeric/string knob this service has (cache TTL seconds, claim-worker poll
 * interval, claim batch size, default max retry attempts, advisory-lock wait timeout, outbox poll
 * interval) reads through this table's resolver (T-RR-006), not a hardcoded constant.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_redemption.service_config (
      id            int          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      config_key    varchar(100) NOT NULL,
      scope_level   varchar(10)  NOT NULL,
      scope_ref     varchar(80)  NULL,
      config_value  text         NOT NULL,
      value_type    varchar(20)  NOT NULL DEFAULT 'string',
      created_at    timestamptz  NOT NULL DEFAULT now(),
      updated_at    timestamptz  NOT NULL DEFAULT now(),
      CONSTRAINT uq_sc_key_scope UNIQUE (config_key, scope_level, scope_ref)
    );`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_redemption.service_config;', {
    type: QueryTypes.RAW,
  });
}
