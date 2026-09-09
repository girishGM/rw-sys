import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-RR-062 (implementation notes 1a/1b). Adds three new nullable columns to
 * `reward_redemption.reward_redemption_entry` (`002_create_reward_redemption_entry.ts`):
 *
 * - `reward_kind varchar(20) NULL` — distinguishes a `PERCENTAGE` reward's `reward_value` (a rate,
 *   never meaningfully summable) from a `FIXED_AMOUNT`/`POINTS` reward's (a real, additive amount),
 *   and from a `PROMO_CODE` reward (tracked as the code itself, never a redemption value) — the
 *   `reward-tracking-service` aggregation-design gap this task's own header describes
 *   (`reward-tracking-service-plan/brain-storm/02-DATA-MODEL.md` §3.1).
 * - `promo_code_config_id varchar(64) NULL` / `promo_code_config_version_no int NULL` — which
 *   promo-code recipe/version produced a `PROMO_CODE`-kind reward; meaningful only when
 *   `reward_kind = 'PROMO_CODE'`, `NULL` otherwise. Same `varchar(64)`/`int` column shapes as
 *   `realtime-activity-processing-service`'s own sibling migration
 *   (`017_add_reward_entry_reward_kind_and_promo_code_pin.ts`, `T-RAP-062`, confirmed by direct
 *   read) — this task never invents its own, independently-chosen width for the same identifier.
 *
 * **Additive, nullable, no backfill, and deliberately never populated by this task**
 * (implementation note 1a/1b): `reward_redemption_entry` has nowhere to read any of these three
 * values from today. All three are cross-repo-blocked on
 * `realtime-activity-processing-service-plan/tasks/T-RAP-062` (still `pending` as of this task —
 * checked directly against that plan's own `progress.json`), the task that first makes RAP stamp
 * `reward_kind`/`promo_code_config_id`/`promo_code_config_version_no` onto its own outbound
 * `reward.entry.created.v1`/`SubmitRewardEntry` payload at all. Until that lands (and until this
 * service's own Wave 1 ingestion, `T-RR-010`, is separately extended to read the new upstream
 * fields — a distinct, not-yet-filed unit of work outside this task's own file scope), every row's
 * `reward_kind`/`promo_code_config_id`/`promo_code_config_version_no` stays `NULL` — "nullable means
 * not yet known, never fabricated," the identical discipline `020_add_reward_redemption_entry_
 * expires_at.ts` (`T-RR-063`) already established for the same reason.
 *
 * This task's own dispatch payload (`toRewardTrackingMessage`/`buildOutboxPayload`) forwards
 * whatever value is on the row — `NULL` today, real once both cross-repo blockers land — never
 * inventing a placeholder.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER TABLE reward_redemption.reward_redemption_entry
       ADD COLUMN reward_kind varchar(20) NULL,
       ADD COLUMN promo_code_config_id varchar(64) NULL,
       ADD COLUMN promo_code_config_version_no int NULL;`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER TABLE reward_redemption.reward_redemption_entry
       DROP COLUMN IF EXISTS reward_kind,
       DROP COLUMN IF EXISTS promo_code_config_id,
       DROP COLUMN IF EXISTS promo_code_config_version_no;`,
    { type: QueryTypes.RAW },
  );
}
