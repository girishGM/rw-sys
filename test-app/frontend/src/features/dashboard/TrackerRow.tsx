/**
 * T-007 — one row of the "Your Progress" trackers widget (`ARCHITECTURE.md` §4: "a compact
 * trackers-progress widget (icon + name + bar per tracker)"). `tracker` is `useDashboard`'s own
 * `DashboardTrackerProgress` — real progress, threshold and completion state, already evaluated
 * server-side against the tracker's actual `completion_logic`. The one thing `GET /api/dashboard`
 * doesn't carry is the reward tied to this tracker, so this component makes its own
 * `useCampaign(campaignCode, customerId)` call (already exposed by `lib/queries.ts`) to read the
 * matching `CampaignDetailTracker.rewards` — React Query dedupes/caches this by
 * `(campaignCode, customerId)`, so multiple trackers on the same campaign share one request.
 *
 * T-INT-021 — a third, distinct render state: `tracker.progressUnknown`. `completedCount`/
 * `completed` are real, RAP-sourced data now, not an invented flag, and RAP can genuinely be
 * unreachable — this must never be conflated with "0 progress" (a customer who has genuinely not
 * started yet would otherwise look identical to one whose real progress just couldn't be fetched
 * this request). Checked first, before either of the other two fields.
 */
import { AlertTriangleIcon, CheckCircleIcon } from '../../components/icons';
import { ProgressBar } from '../../components/ProgressBar';
import { useCampaign } from '../../lib/queries';
import type { DashboardTrackerProgress } from '../../types';
import { getCampaignTheme } from './campaignTheme';
import { formatRewardCopy } from './rewardCopy';

export interface TrackerRowProps {
  tracker: DashboardTrackerProgress;
  customerId: string | null;
}

export function TrackerRow({ tracker, customerId }: TrackerRowProps) {
  const { Icon, gradientClassName } = getCampaignTheme(tracker.campaignCode);
  const campaignQuery = useCampaign(tracker.campaignCode, customerId);

  const detailTracker = campaignQuery.data?.trackers.find(
    (entry) => entry.trackerId === tracker.trackerId,
  );
  // Prefer the tracker's own reward; fall back to the campaign-level one if this particular
  // tracker has none of its own — either way it's a real `RewardAssignment`, never invented copy.
  const reward = detailTracker?.rewards[0] ?? campaignQuery.data?.campaignRewards[0] ?? null;

  const completedCount = tracker.progressUnknown ? 0 : (tracker.completedCount ?? 0);
  const percent = tracker.threshold > 0 ? (completedCount / tracker.threshold) * 100 : 0;
  const remaining = Math.max(0, tracker.threshold - completedCount);

  return (
    <div className="flex items-center gap-4">
      <span
        aria-hidden="true"
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-chip bg-gradient-to-br text-white ${gradientClassName}`}
      >
        <Icon className="h-5 w-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-body text-sm font-semibold text-ink">
            {tracker.trackerName}
          </span>
          <span className="shrink-0 font-body text-xs font-semibold text-ink-muted">
            {tracker.progressUnknown ? '?' : tracker.completedCount}/{tracker.threshold}
          </span>
        </div>

        {tracker.progressUnknown ? (
          <div className="flex items-center gap-1.5 text-ink-muted">
            <AlertTriangleIcon className="h-4 w-4" />
            <span className="font-body text-xs font-semibold">
              Progress unavailable right now — check back soon.
            </span>
          </div>
        ) : tracker.completed ? (
          <div className="flex items-center gap-1.5 text-accent-strong">
            <CheckCircleIcon className="h-4 w-4" />
            <span className="font-body text-xs font-semibold">Reward unlocked!</span>
          </div>
        ) : (
          <>
            <ProgressBar value={percent} aria-label={`${tracker.trackerName} progress`} />
            <p className="font-body text-xs text-ink-muted">
              {reward
                ? `${remaining} more to unlock ${formatRewardCopy(reward)}`
                : `${remaining} more to complete this tracker`}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
