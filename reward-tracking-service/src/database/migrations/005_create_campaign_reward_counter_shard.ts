import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_tracking.campaign_reward_counter_shard` — `brain-storm/02-DATA-MODEL.md` §4, verbatim.
 * The only sharded, hot-write table in this design (R7) — every write is a single atomic
 * `INSERT ... ON CONFLICT DO UPDATE x = x + $delta`, never a read-then-write, so correctness never
 * depends on avoiding a race between concurrent writers to the same shard row.
 *
 * Deliberately NO `shard_key` range CHECK constraint (task implementation note 1, §4): the valid
 * range is enforced by application code reading `service_config`'s
 * `tracking.campaignCounterShardCount`, not the DB, since the configured shard count can change
 * live without a migration (§4's own "confirmed safe to change N later" note) — a CHECK here would
 * have to be dropped/recreated every time an operator changes N, defeating the point of it being a
 * live-tunable ops knob.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_tracking.campaign_reward_counter_shard (
      tenant_id             int           NOT NULL,
      campaign_code         varchar(50)   NOT NULL,
      reward_category       varchar(50)   NOT NULL,
      reward_kind           varchar(20)   NULL,
      unit_type             varchar(14)   NULL,
      unit_code             varchar(10)   NULL,
      shard_key             smallint      NOT NULL,
      total_reward_value    decimal(18,4) NOT NULL DEFAULT 0,
      total_reward_count    int           NOT NULL DEFAULT 0,
      distinct_customer_hll bytea         NULL,
      updated_at            timestamptz   NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, campaign_code, reward_category, reward_kind, unit_type, unit_code,
                   shard_key)
    );`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_tracking.campaign_reward_counter_shard;', {
    type: QueryTypes.RAW,
  });
}
