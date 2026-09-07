import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_tracking.inbound_event_log` — `brain-storm/02-DATA-MODEL.md` §1.1, verbatim. One row
 * per inbound delivery attempt, keyed for idempotency regardless of which of the three channels
 * (Kafka, gRPC, REST) carried it — `uq_iel_reward_entry` is UNIQUE on `reward_entry_id` ALONE, not
 * `(received_channel, reward_entry_id)` (R3: a redelivery of the same event over a *different*
 * channel than the first attempt must still collapse into the same row, never a second one).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_tracking.inbound_event_log (
      id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      reward_entry_id   varchar(64) NOT NULL,
      received_channel  varchar(10) NOT NULL,
      payload           jsonb       NOT NULL,
      received_at       timestamptz NOT NULL DEFAULT now(),
      processed_at      timestamptz NULL,
      processing_status varchar(20) NOT NULL DEFAULT 'received',
      error_message     text        NULL,
      CONSTRAINT uq_iel_reward_entry UNIQUE (reward_entry_id)
    );`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_tracking.inbound_event_log;', {
    type: QueryTypes.RAW,
  });
}
