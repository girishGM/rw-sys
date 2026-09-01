/**
 * T-008 — the real, server-evaluated `TrackerProgressSummary` (`GET /api/campaigns`'s
 * `progress.trackers`, keyed by `trackerId`) is `CampaignDetailPage`'s primary source for a
 * tracker's `completedCount`/`threshold`/`completed` — the same values `TrackerRow` on the
 * Dashboard (T-007) reads, never recomputed from scratch. This fallback only exists for the case
 * `GET /api/campaigns`'s per-campaign `progress` came back `null` (no progress record at all for
 * this customer/campaign — `tracking-service`'s own seed always gives every demo customer a
 * progress row for all 3 demo campaigns, so this path is not expected to run against real seeded
 * data, but a future campaign added without a seeded progress row must still render sensibly
 * rather than crash on a missing summary). Mirrors `tracking-service`'s own real
 * `data/progress.ts` `isTrackerComplete`/`trackerThreshold`/`completedComponentCount` formula
 * exactly (the `all`/`any`/`n_of` semantics are the fixed, real `completion_logic` domain model
 * itself, not a business rule this app invents) applied to `CampaignDetailComponent.completed`,
 * which is already the real, server-evaluated per-component completion flag.
 */
import type { CampaignDetailTracker } from '../../types';

export interface TrackerProgressStats {
  readonly completedCount: number;
  readonly threshold: number;
  readonly completed: boolean;
}

export function deriveTrackerProgress(tracker: CampaignDetailTracker): TrackerProgressStats {
  const completedCount = tracker.components.filter((component) => component.completed).length;
  const threshold = tracker.completionThreshold ?? tracker.components.length;

  if (tracker.components.length === 0) {
    return { completedCount, threshold, completed: false };
  }

  let completed: boolean;
  switch (tracker.completionLogic) {
    case 'all':
      completed = tracker.components.every((component) => component.completed);
      break;
    case 'any':
      completed = tracker.components.some((component) => component.completed);
      break;
    case 'n_of':
      completed = completedCount >= threshold;
      break;
  }

  return { completedCount, threshold, completed };
}
