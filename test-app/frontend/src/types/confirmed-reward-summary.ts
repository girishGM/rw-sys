/**
 * T-INT-022 — mirrors `tracking-service`'s `GET /api/rewards/confirmed` envelope
 * (`routes/rewards.ts`'s `ConfirmedRewardsResult`), which itself passes reward-tracking-service's
 * real `GET /customers/:customerId/rewards/summary` response through verbatim under `status: 'ok'`.
 * Deliberately a separate, additive type from `RewardLedgerEntry` (`./reward.ts`) — this is a
 * rollup/aggregate shape (grouped totals per tracker/component + reward kind), not a per-instance,
 * markable-used ledger entry; see `routes/rewards.ts`'s own header for the full reconciliation
 * decision this task made.
 */

export interface ConfirmedRewardsSummaryComponent {
  readonly trackerCode: string;
  readonly componentCode: string;
  readonly rewardCategory: string;
  readonly rewardKind: string | null;
  readonly unitType?: string | null;
  readonly unitCode?: string | null;
  readonly totalValue?: string;
  readonly totalCount: number;
  readonly averageRatePercent?: string;
  readonly promoCodeConfigId?: string;
  readonly promoCodeConfigVersionNo?: number;
}

export type ConfirmedRewardsResult =
  | { readonly status: 'not_configured' }
  | { readonly status: 'unavailable'; readonly message: string }
  | {
      readonly status: 'ok';
      readonly customerId: string;
      readonly campaignCode?: string;
      readonly components: readonly ConfirmedRewardsSummaryComponent[];
    };
