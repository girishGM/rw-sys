/**
 * T-INT-022 — the wire shape of `reward-tracking-service`'s real
 * `GET /customers/:customerId/rewards/summary` (`customer-rewards.controller.ts`'s `getSummary`,
 * shaped per-component by that service's own shared `shapeRewardGroup`,
 * `reward-kind-response-shaper.ts`) — hand-declared here for the same reason `portal-client/types.ts`
 * hand-declares the portal's own shapes: this app has no dependency on that service's own workspace.
 *
 * Deliberately a **rollup/aggregate** shape (grouped totals per tracker/component + reward kind),
 * not a per-instance ledger entry — RTS's own read API has no concept of an individually
 * addressable, markable-used reward instance today (confirmed by direct read: `shapeRewardGroup`'s
 * own contract only ever emits `totalValue`/`totalCount`, never a per-reward `id`/`status`). This is
 * exactly why this task's own "Files owned" doc keeps `data/rewards.ts` around rather than replacing
 * it outright — see `routes/rewards.ts`'s own header for the full reconciliation decision.
 */

export interface CustomerRewardsSummaryComponent {
  readonly trackerCode: string;
  readonly componentCode: string;
  readonly rewardCategory: string;
  readonly rewardKind: string | null;
  /** Present only for a summable kind (`FIXED_AMOUNT`/`POINTS`) — absent, never `null`, for
   * anything else, matching RTS's own "absent means not summable" wire contract exactly. */
  readonly unitType?: string | null;
  readonly unitCode?: string | null;
  readonly totalValue?: string;
  readonly totalCount: number;
  /** `PERCENTAGE`-only. */
  readonly averageRatePercent?: string;
  /** `PROMO_CODE`-only. */
  readonly promoCodeConfigId?: string;
  readonly promoCodeConfigVersionNo?: number;
}

export interface CustomerRewardsSummary {
  readonly customerId: string;
  readonly campaignCode?: string;
  readonly components: readonly CustomerRewardsSummaryComponent[];
}

export interface GetCustomerRewardsSummaryParams {
  readonly customerId: string;
  /** RTS's `CustomerAuthGuard` scopes every read by tenant — see `token.ts`'s own header for where
   * this app sources it (this app's single portal `tenant_admin` login's own tenant, resolved from
   * whichever real campaign is on hand — there is no per-customer tenant of its own to read). */
  readonly tenantId: number;
  readonly campaignCode?: string;
}
