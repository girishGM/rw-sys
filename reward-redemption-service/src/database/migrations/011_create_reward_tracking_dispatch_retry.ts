import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_tracking_dispatch_retry` — tier-3 retry queue for the outbound leg to
 * reward-tracking-service (`01-DATABASE.md` §7), identical shape to RAP's own
 * `reward_dispatch_retry`. Same FK-ordering requirement as `010_create_reward_tracking_dispatch_outbox.ts`
 * (T-RR-003 note 4) — must migrate after `reward_redemption_entry` exists.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_redemption.reward_tracking_dispatch_retry (
      id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      reward_entry_id uuid        NOT NULL REFERENCES reward_redemption.reward_redemption_entry (id),
      payload         jsonb       NOT NULL,
      attempts        int         NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      status          varchar(20) NOT NULL DEFAULT 'pending',
      last_error      text        NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_redemption.reward_tracking_dispatch_retry;', {
    type: QueryTypes.RAW,
  });
}
