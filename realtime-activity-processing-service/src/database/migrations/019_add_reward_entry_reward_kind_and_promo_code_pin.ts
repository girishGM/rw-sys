import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-RAP-062. `reward_entry.reward_kind`/`promo_code_config_id`/`promo_code_config_version_no` —
 * three additive, nullable columns (`05-PROCESSING-PIPELINE.md` §6 point 3's own "reward_entry —
 * one row per earned reward", `01-DATABASE.md` §7). No backfill: every existing row simply
 * predates these fields, and this task's own Scope explicitly rules out changing any existing
 * field's value.
 *
 * `reward_kind` mirrors `reward_config.reward_versions.reward_kind` (T119) via the cache's own
 * `BoundReward.reward_kind` (T-173/T-RAP-065) — distinguishes a `PERCENTAGE`-kind reward's
 * `reward_value` (a rate, never summable) from a `FIXED_AMOUNT`/`POINTS`-kind reward's
 * `reward_value` (a real additive amount). `promo_code_config_id`/`promo_code_config_version_no`
 * freeze which promo-code-config identity/version was pinned at grant time, only meaningful when
 * `reward_kind = 'PROMO_CODE'` (never enforced by a CHECK here — this task's own Scope: purely
 * descriptive metadata, never a new enforcement input).
 *
 * **Migration number**: this task's own file (`T-RAP-062-stamp-reward-kind-onto-reward-entry.md`,
 * "Files owned") names `017_add_reward_entry_reward_kind_and_promo_code_pin.ts`, written before
 * this session started. The actual next free number in this directory at the time this task ran
 * was `019` (`016`/`017` already claimed by T-INT-011/T-INT-006's own migrations, `018` by
 * T-INT-054) — same "next free number, not the number a task file guessed before it ran"
 * precedent `017_create_reward_dispatch_channel_config.ts`'s own header already records. Recorded
 * here, and in this task's own completion report under "Deviations".
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER TABLE realtime_activity_processing.reward_entry
       ADD COLUMN reward_kind varchar(20) NULL,
       ADD COLUMN promo_code_config_id varchar(64) NULL,
       ADD COLUMN promo_code_config_version_no int NULL;`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER TABLE realtime_activity_processing.reward_entry
       DROP COLUMN IF EXISTS reward_kind,
       DROP COLUMN IF EXISTS promo_code_config_id,
       DROP COLUMN IF EXISTS promo_code_config_version_no;`,
    { type: QueryTypes.RAW },
  );
}
