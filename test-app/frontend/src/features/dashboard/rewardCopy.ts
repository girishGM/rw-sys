/**
 * T-007 — builds the reward half of the trackers widget's motivational copy ("3 more to unlock
 * $20.00 cashback") from a real `RewardAssignment`, per this task's implementation notes:
 * "generated from the real remaining-count + reward value, not a static string per tracker."
 * `unitType` is the real `reward_config.reward_versions` column (see `tracking-service`'s own
 * `data/rewards.ts` `rewardTypeFromUnitType` for the server-side twin of this mapping — not
 * imported from there since it's a tiny, display-only formatting concern, not a shared data
 * contract `types/` mirrors). `UI-UX-DESIGN.md` "Content rules": `$` prefix, two decimal places
 * for cashback amounts.
 */
import type { RewardAssignment } from '../../types';

export function formatRewardCopy(reward: RewardAssignment): string {
  switch (reward.unitType) {
    case 'currency':
      // A real, seeded `reward_config.reward_versions` row can carry a `null` `amount` (a
      // policy-driven/variable amount not fixed at this level) — falling back to `'0'` here would
      // fabricate a "$0.00 cashback" that misstates the actual reward as worthless, exactly the
      // kind of invented-vs-real mismatch `UI-UX-DESIGN.md`'s "Content rules" warns against. Use
      // the reward's own real name instead whenever there's no real number to show.
      return reward.amount !== null
        ? `$${Number(reward.amount).toFixed(2)} cashback`
        // The real seeded reward name already reads as a complete phrase on its own (e.g.
        // "Signup Cashback") — appending "cashback"/"points" here duplicated the word for every
        // reward whose name already ends in its own unit type. Use the name as-is.
        : reward.rewardName;
    case 'voucher':
      return 'a promo code';
    case 'points':
      return reward.amount !== null ? `${reward.amount} points` : reward.rewardName;
    default:
      // Unrecognised `unitType` — fall back to the reward's own display name rather than crash
      // or show nothing.
      return reward.rewardName;
  }
}
