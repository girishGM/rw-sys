/**
 * T-006 — mirrors `tracking-service`'s campaign/tracker/component response shapes
 * (`routes/campaigns.ts`), themselves built from `portal-client/types.ts`'s real portal DTOs plus
 * this app's own invented per-customer completion state layered on top.
 */
import type { TrackerCompletionLogic } from './tracker';

/** A reward attached at campaign/tracker/component level — mirrors `portal-client`'s
 * `PortalRewardAssignment`, passed through by `tracking-service` unchanged. */
export interface RewardAssignment {
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

/** One tracker's progress summary, as embedded in a `CampaignSummary`/`DashboardSummary`
 * (`completedCount`/`threshold`/`completed` — never the raw component list). */
export interface TrackerProgressSummary {
  readonly trackerId: number;
  readonly trackerCode: string;
  readonly trackerName: string;
  readonly completionLogic: TrackerCompletionLogic;
  readonly completedCount: number;
  readonly threshold: number;
  readonly completed: boolean;
}

/** One row of `GET /api/campaigns` — `progress` is `null` whenever the request had no
 * `?customerId=`, or that customer has no progress recorded for this campaign. */
export interface CampaignSummary {
  readonly campaignId: number;
  readonly campaignCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: string;
  readonly progress: { readonly trackers: readonly TrackerProgressSummary[] } | null;
}

/** One tracker component, with this customer's completion flag (`false` when no `?customerId=`
 * was given, or that component isn't in their progress record yet) — `GET /api/campaigns/:code`. */
export interface CampaignDetailComponent {
  readonly componentId: number;
  readonly componentCode: string;
  readonly componentName: string;
  readonly activityName: string | null;
  readonly sequenceOrder: number;
  readonly isMandatory: boolean;
  readonly completed: boolean;
}

export interface CampaignDetailTracker {
  readonly trackerId: number;
  readonly trackerCode: string;
  readonly trackerName: string;
  readonly description: string | null;
  readonly completionLogic: TrackerCompletionLogic;
  readonly completionThreshold: number | null;
  readonly rewards: readonly RewardAssignment[];
  readonly components: readonly CampaignDetailComponent[];
}

/** `GET /api/campaigns/:code` — the full tracker/component breakdown for one campaign. */
export interface CampaignDetail {
  readonly campaignId: number;
  readonly campaignCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: string;
  readonly campaignRewards: readonly RewardAssignment[];
  readonly trackers: readonly CampaignDetailTracker[];
}
