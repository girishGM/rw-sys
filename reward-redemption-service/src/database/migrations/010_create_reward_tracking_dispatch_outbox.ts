import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_tracking_dispatch_outbox` — outbound leg to reward-tracking-service (`01-DATABASE.md`
 * §7), identical shape to RAP's own `reward_entry_outbox`. `reward_entry_id` carries a real,
 * in-schema FK to `reward_redemption_entry` (R5 only forbids a *cross-schema* FK) — must migrate
 * after T-RR-002's `002_create_reward_redemption_entry.ts` (T-RR-003 note 4; this file's own
 * number, 010, is already greater than 002).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_redemption.reward_tracking_dispatch_outbox (
      id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
      reward_entry_id uuid         NOT NULL REFERENCES reward_redemption.reward_redemption_entry (id),
      topic           varchar(100) NOT NULL DEFAULT 'reward.redemption.completed.v1',
      payload         jsonb        NOT NULL,
      status          varchar(20)  NOT NULL DEFAULT 'PENDING',
      attempts        int          NOT NULL DEFAULT 0,
      created_at      timestamptz  NOT NULL DEFAULT now(),
      updated_at      timestamptz  NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_redemption.reward_tracking_dispatch_outbox;', {
    type: QueryTypes.RAW,
  });
}
