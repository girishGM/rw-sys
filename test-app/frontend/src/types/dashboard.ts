/**
 * T-006 — mirrors `GET /api/dashboard`'s response (`routes/dashboard.ts`), the single aggregate
 * call the Dashboard page (T-007) is built on.
 */
import type { RewardLedgerEntry } from './reward';
import type { TrackerCompletionLogic } from './tracker';

export interface ActiveCampaignSummary {
  readonly campaignId: number;
  readonly campaignCode: string;
  readonly campaignName: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: string;
}

export interface DashboardTrackerProgress {
  readonly campaignId: number;
  readonly campaignCode: string;
  readonly campaignName: string;
  readonly trackerId: number;
  readonly trackerCode: string;
  readonly trackerName: string;
  readonly completionLogic: TrackerCompletionLogic;
  readonly completedCount: number;
  readonly threshold: number;
  readonly completed: boolean;
}

export interface RewardCounts {
  readonly total: number;
  readonly unused: number;
  readonly used: number;
}

export interface DashboardSummary {
  readonly customerId: string;
  readonly activeCampaigns: readonly ActiveCampaignSummary[];
  readonly rewardCounts: RewardCounts;
  readonly trackerProgress: readonly DashboardTrackerProgress[];
  readonly expiringSoon: readonly RewardLedgerEntry[];
}
