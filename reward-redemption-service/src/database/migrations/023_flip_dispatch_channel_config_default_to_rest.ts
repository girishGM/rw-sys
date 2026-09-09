import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-INT-001 (`reward-service-integration-plan`). Flips `reward_redemption.dispatch_channel_config`'s
 * seeded `GLOBAL` row (migration `006`) from `primary_channel = 'KAFKA'` to `primary_channel =
 * 'REST'` — per the user's explicit, repo-wide instruction (`reward-service-integration-plan/
 * ARCHITECTURE.md` §4): Render's current tier cannot run gRPC or Kafka, so every configurable
 * leg's `GLOBAL` row must default to REST as its primary transport right now. Kafka stays fully
 * implemented, `kafka_enabled` stays `true`, and it remains selectable at any time via
 * `reward-service-integration-plan/scripts/set-transport-primary.js` — this migration only changes
 * which transport a fresh/reset environment starts on, never removes the capability.
 *
 * `dispatch_channel_config`'s sibling table, `promo_code_channel_config` (migration `018`), already
 * seeds its own `GLOBAL` row with `primary_channel = 'REST'` — confirmed by direct read, no
 * migration needed there, only a confirmation query (this task's own verification step 2 covers
 * `dispatch_channel_config`; `TRANSPORT-CONFIG.md` records the `promo_code_channel_config`
 * confirmation).
 *
 * Numbered `023`, not the task file's own suggested `022` — `022` was free when the task file was
 * written (2026-09-07) but has since been taken by
 * `022_add_reward_redemption_entry_reward_kind_and_promo_code_pin.ts` (landed in the `reward
 * tracking service` commit that merged into this branch). `023` is simply the next free number in
 * this directory's own strictly-increasing, lexicographically-sorted sequence (`umzug.ts`'s own
 * glob) — same "next free number, not the originally-guessed one" precedent migration `021`'s own
 * header already established for the identical reason.
 *
 * Only `primary_channel` changes. `fallback_channel` stays `'REST'` — a Kafka-primary leg falling
 * back to REST was already correct, and this migration does not redesign a REST-primary leg's own
 * fallback choice (out of scope, per this task's own implementation notes). `kafka_enabled` /
 * `rest_enabled` / `grpc_enabled` are untouched — this migration is a routing-preference flip, not
 * a capability change.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `UPDATE reward_redemption.dispatch_channel_config
       SET primary_channel = 'REST', updated_at = now()
       WHERE scope_level = 'GLOBAL' AND scope_ref_code IS NULL AND tenant_id IS NULL;`,
    { type: QueryTypes.RAW },
  );
}

/** Restores `'KAFKA'` — the value migration `006` originally seeded — so this migration has a
 * real, working rollback rather than a no-op, matching every other migration's own R1-equivalent
 * discipline in this service. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `UPDATE reward_redemption.dispatch_channel_config
       SET primary_channel = 'KAFKA', updated_at = now()
       WHERE scope_level = 'GLOBAL' AND scope_ref_code IS NULL AND tenant_id IS NULL;`,
    { type: QueryTypes.RAW },
  );
}
