import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `notification_log` — logged (not sent) push-notification intents (`01-DATABASE.md` §8).
 * `customer_id_hash`, never plaintext (R8). Same FK-ordering requirement as `010`/`011`
 * (T-RR-003 note 4) — must migrate after `reward_redemption_entry` exists.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_redemption.notification_log (
      id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      reward_entry_id   uuid        NOT NULL REFERENCES reward_redemption.reward_redemption_entry (id),
      tenant_id         int         NOT NULL,
      customer_id_hash  varchar(64) NOT NULL,
      campaign_code     varchar(50) NOT NULL,
      reward_code       varchar(80) NOT NULL,
      channel           varchar(20) NOT NULL,
      would_be_payload  jsonb       NOT NULL,
      logged_at         timestamptz NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_redemption.notification_log;', {
    type: QueryTypes.RAW,
  });
}
