/**
 * T-008 — one tracker's full breakdown on Campaign Detail (this task's Scope: "the Trackers
 * section broken down by component (icon, name, progress bar, complete/not-complete state,
 * correctly reflecting the tracker's real `completion_logic`) ... and the Reward card"). Prefers
 * the real, server-evaluated `TrackerProgressSummary` from `GET /api/campaigns` (`summary`) for
 * `completedCount`/`threshold`/`completed`; falls back to `deriveTrackerProgress` only when that
 * summary is missing (`trackerProgress.ts`'s own header explains when that can happen). Renders
 * every component this tracker has and its own reward card regardless of `completionLogic` or
 * component count, so a campaign with multiple trackers or `n_of` logic renders sensibly rather
 * than only working for the demo data's `all`-logic trackers (implementation notes).
 */
import { CheckCircleIcon } from '../../components/icons';
import { ProgressBar } from '../../components/ProgressBar';
import type { CampaignDetailTracker, RewardAssignment, TrackerProgressSummary } from '../../types';
import { completionLogicCopy } from './completionLogicCopy';
import { ComponentRow } from './ComponentRow';
import { RewardCard } from './RewardCard';
import { deriveTrackerProgress } from './trackerProgress';

export interface TrackerCardProps {
  tracker: CampaignDetailTracker;
  summary: TrackerProgressSummary | undefined;
  /** Campaign-level rewards, used as a fallback when this particular tracker has none of its own
   * — the same fallback rule `TrackerRow` (T-007) applies on the Dashboard. */
  campaignRewards: readonly RewardAssignment[];
}

export function TrackerCard({ tracker, summary, campaignRewards }: TrackerCardProps) {
  const stats = summary ?? deriveTrackerProgress(tracker);
  const percent = stats.threshold > 0 ? (stats.completedCount / stats.threshold) * 100 : 0;
  const reward = tracker.rewards[0] ?? campaignRewards[0] ?? null;

  return (
    <div className="flex flex-col gap-4 border-t border-border pt-5 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          {/* `sm:text-base` (not `sm:text-[15px]`) would silently make this heading unreadable at
           * `sm`+ widths: `tailwind.config.ts` (T-005) names a custom color token `base` (for
           * `--bg-base`), which collides with Tailwind's own built-in `text-base` *font-size*
           * utility. Tailwind still emits both the size and the color declaration under the one
           * `.text-base`/`.sm\:text-base` class, and since the `sm:` variant's merged rule is
           * grouped into the stylesheet's trailing `@media` block (after every base-layer utility,
           * including this element's own `text-ink`), the color half wins at `sm`+ widths —
           * rendering the heading in `--bg-base` (the page background colour) on top of a card
           * that *also* uses that background, i.e. invisible. Confirmed live (real DOM, real
           * computed `color`) while verifying this task, not a hypothetical: every other
           * `text-base` use in this codebase happens to be bare (no responsive prefix), which
           * cascades safely only because of base-layer declaration order — fragile, so don't
           * copy it either without checking a real rendered page first. */}
          <h3 className="font-heading text-sm font-semibold text-ink sm:text-[15px]">
            {tracker.trackerName}
          </h3>
          <p className="font-body text-xs text-ink-muted">
            {completionLogicCopy(
              tracker.completionLogic,
              tracker.completionThreshold,
              tracker.components.length,
            )}
          </p>
        </div>
        {stats.completed ? (
          <div className="flex items-center gap-1.5 text-accent-strong">
            <CheckCircleIcon className="h-4 w-4" />
            <span className="font-body text-xs font-semibold">Complete</span>
          </div>
        ) : (
          <span className="font-body text-xs font-semibold text-ink-muted">
            {stats.completedCount}/{stats.threshold}
          </span>
        )}
      </div>

      {!stats.completed && (
        <ProgressBar value={percent} aria-label={`${tracker.trackerName} progress`} />
      )}

      {tracker.components.length > 0 && (
        <ul className="flex flex-col gap-2.5">
          {tracker.components.map((component) => (
            <ComponentRow key={component.componentId} component={component} />
          ))}
        </ul>
      )}

      <RewardCard reward={reward} earned={stats.completed} />
    </div>
  );
}
