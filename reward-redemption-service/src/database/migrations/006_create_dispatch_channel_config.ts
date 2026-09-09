import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `dispatch_channel_config` — campaign/tracker/reward-level Kafka-vs-REST routing
 * (`01-DATABASE.md` §5). Resolution precedence (T-RR-033): `REWARD` → `TRACKER` → `CAMPAIGN` →
 * the one `GLOBAL` row — first match wins, same shape as `service_config`'s own resolver (§6).
 *
 * `uq_dcc_scope`'s plain `UNIQUE (scope_level, scope_ref_code, tenant_id)` deliberately does
 * **not** use the `tenant_key`/`coalesce` generated-column trick §3's `external_reward_system_config`
 * uses (T-RR-003 note 1) — that trick would change this table's own semantics (it exists so a
 * `GLOBAL` row, which has `scope_ref_code = NULL` by definition, and a real `tenant_id = NULL`
 * default-for-every-tenant row at any other scope level both stay unique on their own terms; do
 * not "fix" this to match §3's pattern).
 *
 * Exactly one `GLOBAL` row is seeded as part of this migration (T-RR-003 note 2, `01-DATABASE.md`
 * §5's own note: "so resolution never has no answer") — without it, T-RR-033's resolver has no
 * fallback to fall through to and every lookup that misses every more specific scope throws
 * instead of resolving.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_redemption.dispatch_channel_config (
      id                int          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      scope_level       varchar(10)  NOT NULL,
      scope_ref_code    varchar(80)  NULL,
      tenant_id         int          NULL,
      kafka_enabled     boolean      NOT NULL DEFAULT true,
      rest_enabled      boolean      NOT NULL DEFAULT true,
      primary_channel   varchar(10)  NOT NULL DEFAULT 'KAFKA',
      fallback_channel  varchar(10)  NOT NULL DEFAULT 'REST',
      created_at        timestamptz  NOT NULL DEFAULT now(),
      updated_at        timestamptz  NOT NULL DEFAULT now(),
      CONSTRAINT uq_dcc_scope UNIQUE (scope_level, scope_ref_code, tenant_id)
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `INSERT INTO reward_redemption.dispatch_channel_config
       (scope_level, scope_ref_code, tenant_id, kafka_enabled, rest_enabled, primary_channel, fallback_channel)
     VALUES ('GLOBAL', NULL, NULL, true, true, 'KAFKA', 'REST');`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_redemption.dispatch_channel_config;', {
    type: QueryTypes.RAW,
  });
}
