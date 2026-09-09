/**
 * T-006 — mirrors `GET /api/dashboard`'s response (`routes/dashboard.ts`), the single aggregate
 * call the Dashboard page (T-007) is built on.
 *
 * T-INT-021 — `completedCount`/`completed` widened to nullable, and `progressUnknown` added: the
 * backend now sources these two fields from realtime-activity-processing-service's real progress
 * API instead of an invented flag, and genuinely cannot always answer (not configured, or every
 * transport unreachable) — see `routes/dashboard.ts`'s own header for the full three-outcome
 * contract this type now carries. `TrackerRow`'s own "progress unavailable" state depends on
 * `progressUnknown` being present and checked before either of the other two fields.
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
  /** `null` only when `progressUnknown` is `true` — real RAP-sourced progress otherwise. */
  readonly completedCount: number | null;
  readonly threshold: number;
  /** `null` only when `progressUnknown` is `true` — real RAP-sourced progress otherwise. */
  readonly completed: boolean | null;
  /** `true` when RAP's real progress genuinely could not be determined this request (not
   * configured, or every attempted transport unreachable) — never conflate with a real, legitimate
   * zero (`completedCount: 0`). */
  readonly progressUnknown: boolean;
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
