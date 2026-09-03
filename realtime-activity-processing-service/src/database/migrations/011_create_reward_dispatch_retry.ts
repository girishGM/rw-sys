import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_dispatch_retry` — last-resort fallback table (01-DATABASE.md §9). Written only when
 * both the Kafka outbox publish and the synchronous gRPC fallback to `reward-redemption-service`
 * have failed for a given `reward_entry` (009).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE realtime_activity_processing.reward_dispatch_retry (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      reward_entry_id    uuid NOT NULL REFERENCES realtime_activity_processing.reward_entry(id),
      kafka_attempts     int NOT NULL DEFAULT 0,
      grpc_attempts      int NOT NULL DEFAULT 0,
      failure_reason     text NOT NULL,
      status             varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','exhausted','resolved')),
      next_retry_at      timestamptz NOT NULL DEFAULT now(),
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE INDEX ix_reward_dispatch_retry_due ON realtime_activity_processing.reward_dispatch_retry (status, next_retry_at) WHERE status = 'pending';`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS realtime_activity_processing.reward_dispatch_retry;', {
    type: QueryTypes.RAW,
  });
}
