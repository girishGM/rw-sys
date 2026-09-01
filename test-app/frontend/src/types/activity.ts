/**
 * T-006 — mirrors `POST /api/activities`'s request body and response `data` (`routes/
 * activities.ts`) — the one write endpoint, and the trigger for the SSE events `sseClient.ts`
 * reacts to.
 *
 * T-010 — also mirrors `GET /api/activities?customerId=`'s response (`data/activities.ts`'s
 * `ActivityHistoryEntry`, T-013) — the Activity Simulator's real feed. `ActivityHistoryEntry.progress`
 * is field-for-field the same shape as `ProgressDelta` below (`tracking-service`'s own
 * `ActivityProgressDelta` doc comment records the same "don't import across the routes/data split"
 * reasoning this file already follows one layer up), so it's reused here rather than redeclared.
 */
import type { RewardLedgerEntry } from './reward';

export interface ActivityRequest {
  readonly customerId: string;
  readonly activityType: string;
  readonly merchant?: string;
  readonly amount?: number;
}

export interface ProgressDelta {
  readonly campaignId: number;
  readonly campaignCode: string;
  readonly campaignName: string;
  readonly trackerId: number;
  readonly trackerCode: string;
  readonly trackerName: string;
  readonly componentId: number;
  readonly completedCount: number;
  readonly threshold: number;
  readonly trackerCompleted: boolean;
}

export interface ActivityResult {
  readonly activityId: string;
  readonly customerId: string;
  readonly activityType: string;
  readonly merchant: string | null;
  readonly amount: number | null;
  readonly matched: boolean;
  readonly progress: readonly ProgressDelta[];
  readonly rewards: readonly RewardLedgerEntry[];
}

/** One row of `GET /api/activities?customerId=`, most-recent-first — the Activity Simulator
 * feed's real data source (T-010). Recorded on every `POST /api/activities` call, matched or
 * not, so `matched: false` (no tracker component responded to this activity) is a real, distinct
 * feed entry rather than something the feed silently drops. */
export interface ActivityHistoryEntry {
  readonly id: string;
  readonly customerId: string;
  /** ISO 8601, set server-side at the moment the activity was recorded. */
  readonly timestamp: string;
  readonly activityType: string;
  readonly merchant: string | null;
  readonly amount: number | null;
  /** Server-generated one-line summary (`data/activities.ts`'s `describeActivity`) — always
   * real, never re-derived client-side, so the feed's copy can't drift from what the engine
   * actually decided. */
  readonly description: string;
  readonly matched: boolean;
  readonly progress: readonly ProgressDelta[];
  readonly rewards: readonly RewardLedgerEntry[];
}
