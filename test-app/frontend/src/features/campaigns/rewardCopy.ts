/**
 * T-008 — turns a real `RewardAssignment` into the Reward card's own display strings (a type
 * label + a value line), per this task's Scope: "the Reward card (type, value, earned/not-yet-
 * earned state ...)". `unitType` is the real `reward_config.reward_versions` column (see
 * `tracking-service`'s own `data/rewards.ts` `rewardTypeFromUnitType` for the server-side twin of
 * this mapping — not imported from there since it's a tiny, display-only formatting concern, not
 * a shared data contract `types/` mirrors, same reasoning `features/dashboard/rewardCopy.ts`
 * (T-007) already recorded for its own, differently-shaped copy of this same reward). Kept as its
 * own module (not imported from `features/dashboard/rewardCopy.ts`) for the same cross-feature
 * file-scope reason `campaignTheme.ts` in this folder documents.
 * `UI-UX-DESIGN.md` "Content rules": `$` prefix, two decimal places for cashback amounts.
 */
import type { RewardAssignment } from '../../types';

export function rewardTypeLabel(reward: RewardAssignment): string {
  switch (reward.unitType) {
    case 'currency':
      return 'Cashback';
    case 'voucher':
      return 'Promo Code';
    case 'points':
      return 'Stripe Points';
    default:
      return reward.rewardName;
  }
}

export function rewardValueLabel(reward: RewardAssignment): string {
  switch (reward.unitType) {
    case 'currency':
      // A real, seeded `reward_config.reward_versions` row can carry a `null` `amount` (a
      // policy-driven/variable amount not fixed at this level) — falling back to `'$0.00'` here
      // would fabricate a value the real config never set, exactly the kind of invented-vs-real
      // mismatch `UI-UX-DESIGN.md`'s "Content rules" warns against. Use the reward's own real
      // name instead whenever there's no real number to show.
      return reward.amount !== null ? `$${Number(reward.amount).toFixed(2)}` : reward.rewardName;
    case 'voucher':
      // The real code string is only issued once a customer actually earns it (an invented
      // ledger concern, `ARCHITECTURE.md` §3) — this level only knows the *policy*, so it shows
      // the reward's own name rather than a fabricated code.
      return reward.rewardName;
    case 'points':
      return reward.amount !== null ? `${reward.amount} pts` : reward.rewardName;
    default:
      return reward.rewardName;
  }
}
