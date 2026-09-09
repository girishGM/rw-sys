/**
 * T-006 — the one place every React Query key is built, shared by `lib/queries.ts` (reads) and
 * `lib/sseClient.ts` (cache invalidation on a live event) so the two can never drift apart on
 * what a given query is keyed by.
 */
export const queryKeys = {
  customers: ['customers'] as const,
  dashboard: (customerId: string) => ['dashboard', customerId] as const,
  /** Shared root for every campaign-list query regardless of `customerId` — lets `sseClient.ts`
   * invalidate "any campaigns list" in one call rather than needing to know which `customerId`
   * variants are currently mounted. */
  campaigns: (customerId?: string | null) => ['campaigns', customerId ?? null] as const,
  campaignsRoot: ['campaigns'] as const,
  campaign: (code: string, customerId?: string | null) =>
    ['campaign', code, customerId ?? null] as const,
  campaignRoot: ['campaign'] as const,
  rewards: (customerId: string) => ['rewards', customerId] as const,
  /** T-INT-022 — this customer's confirmed reward-tracking-service summary (`GET
   * /api/rewards/confirmed`), deliberately a distinct key from `rewards` above (the optimistic
   * ledger) — the two are never meant to invalidate together. */
  confirmedRewards: (customerId: string) => ['rewards-confirmed', customerId] as const,
  /** T-010 — this customer's `GET /api/activities` history (the Activity Simulator feed). */
  activities: (customerId: string) => ['activities', customerId] as const,
};
