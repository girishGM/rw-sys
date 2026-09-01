/**
 * T-009 — turns a real `RewardLedgerEntry` (`GET /api/rewards`, T-003's own invented ledger, see
 * `tracking-service/src/data/rewards.ts`) into this page's display strings: the group heading per
 * type (`ARCHITECTURE.md` §4: "grouped by type (Cashback / Promo Code / Stripe Points)") and the
 * card's value line. Deliberately its own module, not imported from
 * `features/campaigns/rewardCopy.ts` (T-008) — that one formats a *policy-level*
 * `RewardAssignment` (`unitType`, an `amount` that may be `null`), this one formats an *earned,
 * ledger* `RewardLedgerEntry` (`type`, a `value` that's always a real, already-issued string) —
 * two differently-shaped inputs, same cross-feature file-scope reasoning
 * `features/campaigns/campaignTheme.ts`'s own header already recorded for why these feature
 * folders don't share a module.
 * `UI-UX-DESIGN.md` "Content rules": `$` prefix, two decimal places for cashback amounts.
 */
import type { RewardLedgerEntry, RewardType } from '../../types';

export function rewardTypeLabel(type: RewardType): string {
  switch (type) {
    case 'cashback':
      return 'Cashback';
    case 'promo_code':
      return 'Promo Code';
    case 'points':
      return 'Stripe Points';
  }
}

/** Lowercase, singular-friendly form for empty-state copy ("No promo codes yet") — kept separate
 * from {@link rewardTypeLabel} so that one stays the exact group-heading casing the design spec
 * names, without every caller re-deriving a lowercase form from it. */
export function rewardTypeNounPlural(type: RewardType): string {
  switch (type) {
    case 'cashback':
      return 'cashback rewards';
    case 'promo_code':
      return 'promo codes';
    case 'points':
      return 'Stripe Points';
  }
}

export function rewardValueLabel(reward: RewardLedgerEntry): string {
  switch (reward.type) {
    case 'cashback': {
      // `value` is always a real, already-issued string (`data/rewards.ts`'s own doc comment:
      // "never coerced through a float") — re-parsed here only to apply the 2-decimal-place
      // content rule, falling back to the raw string verbatim if it's ever not numeric.
      const amount = Number(reward.value);
      return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : reward.value;
    }
    case 'points':
      return `${reward.value} pts`;
    case 'promo_code':
      return reward.value;
  }
}
