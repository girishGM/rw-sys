import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_entry_outbox` — transactional outbox, Kafka leg (01-DATABASE.md §8). Same proven
 * pattern as `promo_code.promo_code_outbox`: written in the same transaction as `reward_entry`
 * (009), drained by a separate publisher.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE realtime_activity_processing.reward_entry_outbox (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      reward_entry_id    uuid NOT NULL REFERENCES realtime_activity_processing.reward_entry(id),
      topic              varchar(120) NOT NULL,
      payload            jsonb NOT NULL,
      status             varchar(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PUBLISHED','FAILED')),
      attempts           smallint NOT NULL DEFAULT 0,
      created_at         timestamptz NOT NULL DEFAULT now(),
      published_at       timestamptz NULL
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE INDEX ix_reward_entry_outbox_pending ON realtime_activity_processing.reward_entry_outbox (status, created_at) WHERE status = 'PENDING';`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS realtime_activity_processing.reward_entry_outbox;', {
    type: QueryTypes.RAW,
  });
}
