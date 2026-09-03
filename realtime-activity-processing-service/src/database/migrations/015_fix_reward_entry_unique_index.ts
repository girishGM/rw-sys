import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-RAP-049. Fixes a real reward-issuance correctness bug filed by T-RAP-034: the
 * `uc_reward_entry_completion` unique index created by `009_create_reward_entry.ts`
 * (`tenant_id, customer_id_hash, campaign_code, tracker_code, tracker_component_code,
 * completion_cycle`) carries no reward/assignment discriminator, while
 * `05-PROCESSING-PIPELINE.md` §6 and `CapEnforcementService.enforceForCompletion` (T-RAP-033)
 * both explicitly support more than one `BoundReward` assignment being granted on the very same
 * tracker-component completion. Because the old index has no `reward_code` column, every
 * `reward_entry` insert after the first for a given completion tuple collides on conflict —
 * `RewardEntryRepository.insertForGrantedAssignment`'s `ON CONFLICT ... DO NOTHING` workaround
 * (T-RAP-034) keeps the transaction alive but silently drops every reward past the first, even
 * though that reward's budget/customer-limit consumption was already committed in the same
 * transaction. Adding `reward_code` to the index lets each distinct bound reward earn its own
 * row for the same completion, while still rejecting a genuine duplicate (the exact same reward
 * re-inserted for the exact same completion cycle) — which is the only case
 * `uc_reward_entry_completion` ever needed to guard against in the first place.
 *
 * `reward_code` is `NOT NULL varchar(80)` on `reward_entry` (`01-DATABASE.md` §7,
 * `009_create_reward_entry.ts`), so it participates in the unique index with standard SQL
 * NULL-safe semantics with no special-casing needed (a NULL would make two rows "distinct" for
 * uniqueness purposes, which is not a concern here since the column can never be NULL).
 *
 * Down: drops the corrected index and recreates the original 6-column one exactly as
 * `009_create_reward_entry.ts` defined it, so `migrate -> rollback -> migrate` round-trips
 * cleanly (R7) back to the pre-T-RAP-049 shape.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP INDEX realtime_activity_processing.uc_reward_entry_completion;', {
    type: QueryTypes.RAW,
  });
  await context.query(
    `CREATE UNIQUE INDEX uc_reward_entry_completion ON realtime_activity_processing.reward_entry
       (tenant_id, customer_id_hash, campaign_code, tracker_code, tracker_component_code,
        completion_cycle, reward_code);`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP INDEX realtime_activity_processing.uc_reward_entry_completion;', {
    type: QueryTypes.RAW,
  });
  await context.query(
    `CREATE UNIQUE INDEX uc_reward_entry_completion ON realtime_activity_processing.reward_entry
       (tenant_id, customer_id_hash, campaign_code, tracker_code, tracker_component_code,
        completion_cycle);`,
    { type: QueryTypes.RAW },
  );
}
