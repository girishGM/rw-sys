/**
 * T-010 — the reward-landed toast (`UI-UX-DESIGN.md` "Core components": "floating glass card,
 * ... icon chip + headline + one line of detail + a 'View in My Rewards' link with an arrow
 * icon"). `reward`/`campaignName` are always real (`ActivitySimulatorPage` only ever renders this
 * from a genuine `reward-earned` SSE event for the currently-selected customer, never a hardcoded
 * always-visible element like the mockup's static version). `role="status"`/`aria-live="polite"`
 * so the win is announced to assistive tech the moment it appears, without stealing focus.
 */
import { Link } from 'react-router-dom';
import { Card } from '../../components/Card';
import { ArrowRightIcon, GiftIcon, XIcon } from '../../components/icons';
import type { RewardLedgerEntry } from '../../types';
import { rewardBadgeLabel } from './activityCopy';

export interface RewardToastProps {
  readonly reward: RewardLedgerEntry;
  /** Resolved by the caller from `reward.campaignCode` (`useCampaigns`) — falls back to the raw
   * code if that campaign isn't in the caller's lookup yet, same convention as
   * `features/rewards/RewardListCard.tsx`'s own `campaignName` prop. */
  readonly campaignName: string;
  readonly onClose: () => void;
}

export function RewardToast({ reward, campaignName, onClose }: RewardToastProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed right-4 top-24 z-50 w-[min(360px,calc(100vw-2rem))] sm:right-8"
    >
      <Card className="flex items-start gap-3 p-4 shadow-2xl">
        <span
          aria-hidden="true"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-chip bg-gradient-to-br from-accent to-secondary text-white"
        >
          <GiftIcon className="h-5 w-5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-start justify-between gap-2">
            <p className="font-heading text-sm font-bold text-ink">Reward earned!</p>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={onClose}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-muted hover:text-ink"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
          <p className="truncate font-body text-sm text-ink">
            {rewardBadgeLabel(reward)} <span className="text-ink-muted">· {campaignName}</span>
          </p>
          <Link
            to="/rewards"
            className="mt-1 inline-flex w-fit items-center gap-1.5 font-body text-xs font-semibold text-accent-strong hover:underline"
          >
            View in My Rewards
            <ArrowRightIcon className="h-3.5 w-3.5" />
          </Link>
        </div>
      </Card>
    </div>
  );
}
