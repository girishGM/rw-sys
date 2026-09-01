/**
 * T-010 — display copy for one feed entry's `progress`/`rewards` arrays (`ActivityHistoryEntry`,
 * T-013) and for the reward-landed toast. A small, page-local formatter rather than an import from
 * `features/rewards/rewardCopy.ts` — same cross-feature-file-scope reasoning
 * `features/rewards/rewardCopy.ts`'s own header already records for not importing
 * `features/campaigns/rewardCopy.ts`: this is a different task's file, and the two inputs
 * (`ProgressDelta`/`RewardLedgerEntry`) are this task's own real, server-computed shapes, not
 * something worth coupling two feature folders over. `UI-UX-DESIGN.md` "Content rules": `$`
 * prefix, two decimal places for cashback amounts.
 */
import type { ProgressDelta, RewardLedgerEntry } from '../../types';

/** "Grocery Streak: 4 of 5" / "Weekend Spree: 2 of 2 — complete!" — one progress delta from a
 * feed entry (TC-1: "the real progress delta", not just a bare "progress updated"). */
export function progressDeltaLabel(delta: ProgressDelta): string {
  const base = `${delta.trackerName}: ${delta.completedCount} of ${delta.threshold}`;
  return delta.trackerCompleted ? `${base} — complete!` : base;
}

/** The reward-value half of a feed badge / the toast's detail line — mirrors
 * `features/rewards/rewardCopy.ts`'s `rewardValueLabel` field-for-field (same real
 * `RewardLedgerEntry.value`/`type` contract), duplicated rather than imported for the reason this
 * file's own header explains. */
export function rewardBadgeLabel(reward: RewardLedgerEntry): string {
  switch (reward.type) {
    case 'cashback': {
      const amount = Number(reward.value);
      return Number.isFinite(amount)
        ? `$${amount.toFixed(2)} cashback`
        : `${reward.value} cashback`;
    }
    case 'points':
      return `${reward.value} points`;
    case 'promo_code':
      return `Promo code ${reward.value}`;
  }
}
