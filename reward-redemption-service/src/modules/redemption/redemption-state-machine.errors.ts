import type { RewardRedemptionEntryStatus } from '@/database/models/reward-redemption-entry.model';

/**
 * T-RR-021. Thrown when a caller attempts a transition `05-PROCESSING-PIPELINE.md` §2's table has
 * no edge for — most importantly, no `dispatched_external -> failed` and no `completed -> retrying`
 * edge (implementation note 3, TC-6/TC-7). This is a real structural guard, not a convenience
 * check: `RedemptionStateMachineService` is documented as "the single place every status
 * transition is written" specifically so this invariant can be enforced in one place and asserted
 * loudly, rather than trusted to every call site individually. Reaching this means a *caller's*
 * own logic has a bug — never something normal call patterns can legitimately trigger.
 */
export class InvalidRedemptionStateTransitionError extends Error {
  constructor(
    entryId: string,
    fromStatus: RewardRedemptionEntryStatus,
    action: string,
    allowedFromStatuses: RewardRedemptionEntryStatus[],
  ) {
    super(
      `Cannot ${action} for reward_redemption_entry ${entryId}: current status is "${fromStatus}", ` +
        `but this transition is only valid from one of [${allowedFromStatuses.join(', ')}] ` +
        '(05-PROCESSING-PIPELINE.md §2 has no edge for this transition).',
    );
    this.name = 'InvalidRedemptionStateTransitionError';
  }
}

/** Thrown when a caller references an `id` that has no matching `reward_redemption_entry` row at
 * all — distinct from an illegal transition (TC-6/TC-7 above): there is no row to lock in the
 * first place. Callers are expected never to hit this in practice (every id passed to this service
 * comes from a row this service, or the claim worker, already fetched from the database), so this
 * is a defensive guard against a caller-supplied id typo, not a normal/expected outcome. */
export class RedemptionEntryNotFoundError extends Error {
  constructor(entryId: string) {
    super(`reward_redemption_entry ${entryId} does not exist.`);
    this.name = 'RedemptionEntryNotFoundError';
  }
}
