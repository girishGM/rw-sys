/**
 * T-006 — mirrors `tracking-service`'s reward ledger shape (`data/rewards.ts`'s
 * `RewardLedgerEntry`/`RewardType`/`RewardStatus`), returned by `GET /api/rewards`, embedded in
 * `GET /api/dashboard`'s `expiringSoon`, and appended to by `POST /api/activities`'s `rewards`.
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
  /** Always a display-ready string — the cashback amount, the promo code, or the point count —
   * never coerced through a float (matches `tracking-service`'s own `data/rewards.ts` comment). */
  readonly value: string;
  readonly currency: string | null;
  readonly status: RewardStatus;
  readonly issuedAt: string;
  readonly expiresAt: string | null;
}
