import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-RR-063. Adds `reward_redemption_entry.expires_at` — the absolute UTC instant a redeemed
 * reward stops being usable, computed once at redemption time from the `BoundReward`'s
 * `expiry_value`/`expiry_unit` duration (T-173 on the portal side) and the exact `redeemed_at`
 * instant (`RedemptionStateMachineService.markDispatchedExternal`/`markCompletedDirect`, the two
 * places `redeemed_at` is ever stamped). See `expiry-computation.ts` for the pure computation and
 * this task's own file header for why it must be computed here, at redemption time, rather than
 * as a fixed calendar date on the portal.
 *
 * Numbered `020`, not the task file's own suggested `015` — `015`/`016` were already taken by
 * `015_seed_service_config_defaults.ts`/`016_seed_campaign_config_ttl.ts` by the time this task
 * ran (`017` is a deliberately skipped/reserved number; `018`/`019` are T-RR-080/T-RR-081's own
 * migrations) — `020` is simply the next free number in this directory's own strictly-increasing,
 * lexicographically-sorted sequence (`umzug.ts`'s own glob).
 *
 * Additive, nullable, no backfill: every pre-existing row simply has no known expiry (correct —
 * it was redeemed before this column, and the config it would derive from, existed at all).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER TABLE reward_redemption.reward_redemption_entry
       ADD COLUMN expires_at timestamptz NULL;`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER TABLE reward_redemption.reward_redemption_entry DROP COLUMN IF EXISTS expires_at;`,
    { type: QueryTypes.RAW },
  );
}
