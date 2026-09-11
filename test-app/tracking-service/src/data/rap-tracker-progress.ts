/**
 * T-INT-055 — the "join RAP's tracker-code-keyed progress onto this app's own portal-sourced
 * journey/`ProgressStore` structure" logic, extracted from `routes/dashboard.ts` (T-INT-021) so
 * `routes/campaigns.ts`'s own tracker-progress summary (the `completedCount`/`completed` numbers
 * `TrackerCard` renders on Campaign Detail) reads from the exact same RAP-sourced completion state
 * the Dashboard already shows for the same tracker — never a second, independently-maintained
 * version of this join that could silently drift from the first (this task's own Implementation
 * note 1). `routes/dashboard.ts` now imports from here too, rather than keeping its own copy.
 *
 * Three-outcome contract, unchanged from T-INT-021's original header comment on
 * `routes/dashboard.ts`:
 *   - `rapProgress === null` (RAP not configured, or every attempted transport failed) →
 *     `progressUnknown: true`, `completedCount`/`completed` both `null`. `threshold` is still
 *     reported (it's structural — sourced from `ProgressStore`/the portal journey, never from
 *     RAP), so a UI can still show "?/N" rather than losing the denominator too.
 *   - RAP reached, but this tracker has no materialized progress yet → a real, legitimate zero
 *     (`progressUnknown: false`, `completedCount: 0`, `completed: false`) — RAP's own contract:
 *     "Empty trackers is a normal response", never treated as unknown.
 *   - RAP reached with real progress for this tracker → reflected verbatim.
 */
import { trackerThreshold, type TrackerProgress } from './progress';
import {
  RapProgressRequestError,
  RapProgressTransportNotAvailableError,
  RapProgressUnavailableError,
  RapProgressUnreachableError,
  type RapCampaignProgress,
  type RapProgressReader,
} from '../rap-progress-client';

export interface RapJoinedTrackerProgress {
  readonly completedCount: number | null;
  readonly threshold: number;
  readonly completed: boolean | null;
  /** `true` when RAP's real progress genuinely could not be determined this request (not
   * configured, or every attempted transport unreachable) — never conflate with a real,
   * legitimate zero (`completedCount: 0`). */
  readonly progressUnknown: boolean;
}

/** Joins one tracker's real, portal/`ProgressStore`-sourced structure (`tracker`) onto whatever
 * RAP reported for its owning campaign (`rapProgress`, already fetched by {@link fetchRapProgress}
 * — `null` when RAP genuinely couldn't answer this request). */
export function joinRapTrackerProgress(
  tracker: TrackerProgress,
  rapProgress: RapCampaignProgress | null,
): RapJoinedTrackerProgress {
  const threshold = trackerThreshold(tracker);

  if (rapProgress === null) {
    return { completedCount: null, threshold, completed: null, progressUnknown: true };
  }

  const rapTracker = rapProgress.trackers.find(
    (entry) => entry.trackerCode === tracker.trackerCode,
  );
  return {
    completedCount: rapTracker?.componentsCompletedCount ?? 0,
    threshold,
    completed: rapTracker?.isCompleted ?? false,
    progressUnknown: false,
  };
}

/** This app has exactly one portal `tenant_admin` login, so every campaign it ever sees belongs to
 * the same tenant — the same "resolved from whichever real campaign is on hand" sourcing
 * `reward-tracking-client`'s own `routes/rewards.ts` (T-INT-022) already established for the
 * identical problem (there is no per-customer tenant id anywhere in this app's own model). `null`
 * only when the portal has reported zero campaigns at all. */
export function resolveTenantId(realCampaigns: readonly { tenantId: number }[]): number | null {
  return realCampaigns[0]?.tenantId ?? null;
}

/** Fetches one campaign's real progress from RAP, or `null` when it genuinely cannot be determined
 * right now (not configured, or every attempted transport unreachable) — never throws, per
 * T-INT-021's Implementation note 4 "degrade gracefully, don't crash the page" contract. A
 * reached-but-rejected request (`RapProgressRequestError` — a real auth/config problem) is logged
 * more loudly than a plain unreachable, since that one likely needs a human to fix a secret/config
 * mismatch rather than just "RAP isn't running locally right now". */
export async function fetchRapProgress(
  rapProgress: RapProgressReader | null,
  tenantId: number | null,
  customerId: string,
  campaignCode: string,
): Promise<RapCampaignProgress | null> {
  if (!rapProgress || tenantId === null) return null;

  try {
    return await rapProgress.getCampaignProgress({ customerId, tenantId, campaignCode });
  } catch (error) {
    if (
      error instanceof RapProgressUnreachableError ||
      error instanceof RapProgressUnavailableError ||
      error instanceof RapProgressTransportNotAvailableError
    ) {
      console.warn(
        `rap-progress-client: progress unavailable for customer=${customerId} ` +
          `campaign=${campaignCode} (rendering as unknown): ${error.message}`,
      );
    } else if (error instanceof RapProgressRequestError) {
      console.warn(
        `rap-progress-client: RAP rejected the progress request for customer=${customerId} ` +
          `campaign=${campaignCode} (rendering as unknown — check PROGRESS_API_AUTH_SECRET/` +
          `tenant config): ${error.message}`,
      );
    } else {
      console.warn(
        `rap-progress-client: unexpected error fetching progress for customer=${customerId} ` +
          `campaign=${campaignCode} (rendering as unknown): ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
    return null;
  }
}
