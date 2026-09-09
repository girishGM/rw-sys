import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-INT-051 (filed per `reward-service-integration-plan/AGENT-PROTOCOL.md` §7.1, discovered
 * during T-INT-040's own live run — 24,307 permanently-undecryptable `PENDING` rows starving
 * every genuinely-dispatchable row queued behind them in `FIND_PENDING_BATCH_SQL`'s strict FIFO
 * `ORDER BY created_at ASC LIMIT $1`).
 *
 * `010_create_reward_tracking_dispatch_outbox.ts` declared `status varchar(20)` with **no CHECK
 * constraint** (only an inline SQL comment listing `'PENDING' | 'PUBLISHED' | 'FAILED'`) — so the
 * new terminal value this task introduces, `'POISONED'` (9 characters, well inside the existing
 * `varchar(20)` bound), needs **no schema change at all** to become a legal value in that column.
 * `reward-tracking-outbox.repository.ts`'s own `DispatchOutboxStatus` type is widened to include
 * it in application code only.
 *
 * This migration adds exactly one new column this task's own Scope genuinely needs beyond that:
 * `last_error` — TC-3's own operator-audit mechanism (this task's "implementer's choice", noted in
 * the completion report) needs somewhere to record *why* a row was poisoned (and, short of that,
 * why its most recent throw-before-any-dispatch-attempt failure happened at all) so
 * `findPoisoned()` returns something actionable, not just a bare id. Mirrors
 * `reward_tracking_dispatch_retry.last_error` (`010_create_reward_tracking_dispatch_outbox.ts`'s
 * own sibling table, `01-DATABASE.md` §7) — same column name, same nullable `text` type, same
 * "written on failure, never read by any dispatch-decision logic" role.
 *
 * Numbered `026` — `025_create_portal_config_channel_config.ts` is the highest existing migration
 * in this directory as of this task being picked up.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER TABLE reward_redemption.reward_tracking_dispatch_outbox
       ADD COLUMN last_error text NULL;`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER TABLE reward_redemption.reward_tracking_dispatch_outbox
       DROP COLUMN IF EXISTS last_error;`,
    { type: QueryTypes.RAW },
  );
}
