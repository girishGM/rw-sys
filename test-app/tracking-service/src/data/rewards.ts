/**
 * T-003 — a customer's accumulated reward ledger (ARCHITECTURE.md §3), invented in the same sense
 * `progress.ts` is: no such entity exists in `reward_config`/`reward_portal`, but every entry's
 * `campaignId`/`campaignCode` traces back to a real campaign fetched via `portal-client`.
 */
export const REWARD_TYPES = ['cashback', 'promo_code', 'points'] as const;
export type RewardType = (typeof REWARD_TYPES)[number];

export const REWARD_STATUSES = ['unused', 'used'] as const;
export type RewardStatus = (typeof REWARD_STATUSES)[number];

export interface RewardLedgerEntry {
  readonly id: string;
  readonly customerId: string;
  readonly campaignId: number;
  readonly campaignCode: string;
  readonly type: RewardType;
  /** The cashback amount, the promo code itself, or the point count — always a display-ready
   * string, never coerced through a float (the same "money never crosses a boundary as a number"
   * discipline `portal/back-end`'s own `merchant-portal.schema.ts` documents). */
  readonly value: string;
  /** ISO 4217 currency code for `cashback`; `null` for `promo_code`/`points`, which are not
   * currency-denominated. */
  readonly currency: string | null;
  readonly status: RewardStatus;
  readonly issuedAt: string;
  readonly expiresAt: string | null;
}

/**
 * `portal-client`'s `PortalRewardAssignment.unitType` → this app's own reward kind. `unitType` is
 * exactly the real column the 3 seeded `reward_config.reward_versions` rows (T900_003) carry:
 * `currency` for cashback, `voucher` for a promo code, `points` for Stripe Points.
 */
export function rewardTypeFromUnitType(unitType: string | null): RewardType {
  switch (unitType) {
    case 'currency':
      return 'cashback';
    case 'voucher':
      return 'promo_code';
    case 'points':
      return 'points';
    default:
      throw new Error(`rewardTypeFromUnitType: unrecognised unitType "${String(unitType)}"`);
  }
}

/** Keyed by {@link Customer.id}. */
export class RewardsStore {
  private readonly byCustomer = new Map<string, RewardLedgerEntry[]>();

  getForCustomer(customerId: string): readonly RewardLedgerEntry[] {
    return this.byCustomer.get(customerId) ?? [];
  }

  setForCustomer(customerId: string, entries: readonly RewardLedgerEntry[]): void {
    this.byCustomer.set(customerId, [...entries]);
  }

  addReward(entry: RewardLedgerEntry): void {
    const existing = this.byCustomer.get(entry.customerId) ?? [];
    this.byCustomer.set(entry.customerId, [...existing, entry]);
  }

  /** Flips one reward to `used`. Returns the updated entry, or `null` if no such reward exists
   * for that customer. */
  markUsed(customerId: string, rewardId: string): RewardLedgerEntry | null {
    const existing = this.byCustomer.get(customerId);
    const index = existing?.findIndex((entry) => entry.id === rewardId) ?? -1;
    if (existing === undefined || index === -1) return null;

    const updated: RewardLedgerEntry = { ...existing[index], status: 'used' };
    const next = [...existing];
    next[index] = updated;
    this.byCustomer.set(customerId, next);
    return updated;
  }
}
