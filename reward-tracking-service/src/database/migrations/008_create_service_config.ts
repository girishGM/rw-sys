import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_tracking.service_config` — mirrors `reward-redemption-service`'s own
 * `(config_key/scope_level/scope_ref/config_value/value_type)` shape exactly (task implementation
 * note 3), not RAP's own slightly different `service_config` shape (which lacks `value_type` and
 * uses a `CHECK` on `scope_level`) — this task's own file list and prose both cite RR by name for
 * this table.
 *
 * Seeds exactly one `GLOBAL`-scope row, `tracking.campaignCounterShardCount = 32` (task
 * implementation note 3, `brain-storm/02-DATA-MODEL.md` §4's confirmed default / `BACKLOG.md`
 * RS-03) — done inline in this same migration (not a separate seed migration, unlike RR's own
 * `015_seed_service_config_defaults.ts`) since this task's own "Files owned" list names exactly
 * eight migrations, `008_create_service_config.ts` being the last, with no ninth seed file.
 */
const SHARD_COUNT_CONFIG_KEY = 'tracking.campaignCounterShardCount';
const SHARD_COUNT_DEFAULT = '32';

export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_tracking.service_config (
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

  await context.query(
    `INSERT INTO reward_tracking.service_config
       (config_key, scope_level, scope_ref, config_value, value_type)
     VALUES (:key, 'GLOBAL', NULL, :value, 'int');`,
    {
      type: QueryTypes.RAW,
      replacements: { key: SHARD_COUNT_CONFIG_KEY, value: SHARD_COUNT_DEFAULT },
    },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_tracking.service_config;', {
    type: QueryTypes.RAW,
  });
}
