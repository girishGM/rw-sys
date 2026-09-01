/**
 * T-010 — one real `ActivityHistoryEntry` (`GET /api/activities`, T-013) in the feed: an icon
 * keyed to what actually happened (reward earned / progress updated / no match — TC-1/TC-2/TC-5
 * all render distinctly, never the same generic row), the server's own `description`, every real
 * progress delta ("3 of 5 → 4 of 5" via `progressDeltaLabel`, TC-1's "the real progress delta, not
 * a bare success message"), and any reward this exact activity minted.
 */
import { Badge } from '../../components/Badge';
import { CheckCircleIcon, GiftIcon, ZapIcon } from '../../components/icons';
import type { ActivityHistoryEntry } from '../../types';
import { progressDeltaLabel, rewardBadgeLabel } from './activityCopy';
import { formatActivityTimestamp } from './formatActivityTimestamp';

export interface ActivityFeedItemProps {
  readonly entry: ActivityHistoryEntry;
}

export function ActivityFeedItem({ entry }: ActivityFeedItemProps) {
  const hasReward = entry.rewards.length > 0;
  const Icon = hasReward ? GiftIcon : entry.matched ? CheckCircleIcon : ZapIcon;
  const iconChipClass = hasReward
    ? 'bg-gradient-to-br from-accent to-secondary text-white'
    : entry.matched
      ? 'bg-accent-soft text-accent-strong'
      : 'bg-surface-2 text-ink-muted';

  return (
    <li className="flex gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-chip ${iconChipClass}`}
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="font-body text-sm font-semibold text-ink">{entry.description}</p>
          <span className="shrink-0 font-body text-xs text-ink-muted">
            {formatActivityTimestamp(entry.timestamp)}
          </span>
        </div>

        {entry.merchant !== null && (
          <p className="font-body text-xs text-ink-muted">
            {entry.merchant}
            {entry.amount !== null ? ` · $${entry.amount.toFixed(2)}` : ''}
          </p>
        )}

        {entry.progress.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {entry.progress.map((delta) => (
              <Badge
                key={`${delta.trackerId}-${delta.componentId}`}
                tone={delta.trackerCompleted ? 'accent' : 'muted'}
              >
                {progressDeltaLabel(delta)}
              </Badge>
            ))}
          </div>
        )}

        {entry.rewards.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {entry.rewards.map((reward) => (
              <Badge key={reward.id} tone="accent">
                {rewardBadgeLabel(reward)}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}
