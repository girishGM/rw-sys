/**
 * T-003 — the subset of `portal/back-end`'s real wire shapes this service actually consumes.
 *
 * Hand-declared here rather than imported from `@reward-portal/shared`: `test-app` is a
 * standalone workspace with no dependency on the portal's own npm workspace (ARCHITECTURE.md §2
 * — "tracking-service ... never calls `portal/back-end` directly [other than this REST client]").
 * Field names/shapes were read directly from `portal/back-end`'s own DTOs
 * (`campaigns.controller.ts`, `campaign.schema.ts`'s `journeySchema`), not guessed — see the T-003
 * completion report for the exact routes and a real response sample.
 */

/** One row of `GET /api/v1/campaigns` (`campaign-response.dto.ts`'s `toCampaignDto`), trimmed to
 * the fields this app displays. `region` is deliberately absent — the real `Campaign` DTO has no
 * such field (only the merchant-only `/merchant/campaigns` projection does; see the completion
 * report's "Deviations from spec" for why this client does not use that route). */
export interface PortalCampaign {
  readonly id: number;
  readonly campaignCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: string;
}

export const TRACKER_COMPLETION_LOGICS = ['all', 'any', 'n_of'] as const;
export type TrackerCompletionLogic = (typeof TRACKER_COMPLETION_LOGICS)[number];

/** A reward attached at campaign/tracker/component level (`rewardAssignmentSchema`). `unitType`
 * is what this app maps to its own `cashback | promo_code | points` reward kind — see
 * `data/rewards.ts`. */
export interface PortalRewardAssignment {
  readonly id: number;
  readonly level: 'campaign' | 'tracker' | 'component';
  readonly refId: number | null;
  readonly rewardPolicyId: number;
  readonly rewardPolicyName: string;
  readonly rewardId: number;
  readonly rewardName: string;
  readonly unitType: string | null;
  readonly unitCode: string | null;
  readonly amount: string | null;
  readonly status: string;
}

/** One tracker component (`componentSchema`), i.e. one real, addressable unit of progress. */
export interface PortalJourneyComponent {
  readonly id: number;
  readonly componentCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly activityId: number | null;
  readonly activityName: string | null;
  readonly sequenceOrder: number;
  readonly isMandatory: boolean;
  readonly status: string;
}

/** One tracker (`trackerSchema`) — `completionLogic`/`completionThreshold` are exactly the two
 * fields ARCHITECTURE.md §3 says the activity-evaluation engine (T-004) must use, not re-derive. */
export interface PortalJourneyTracker {
  readonly id: number;
  readonly trackerCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly completionLogic: TrackerCompletionLogic;
  readonly completionThreshold: number | null;
  readonly isPrimary: boolean;
  readonly status: string;
  readonly components: readonly PortalJourneyComponent[];
  readonly rewards: readonly PortalRewardAssignment[];
}

/** `GET /api/v1/campaigns/:id/journey` (`journeySchema`) — the whole tracker/component tree. */
export interface PortalCampaignJourney {
  readonly campaignId: number;
  readonly trackers: readonly PortalJourneyTracker[];
  readonly campaignRewards: readonly PortalRewardAssignment[];
}
