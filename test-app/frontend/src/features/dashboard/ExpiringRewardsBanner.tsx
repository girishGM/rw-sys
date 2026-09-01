/**
 * T-007 — the expiring-rewards alert banner (`ARCHITECTURE.md` §4), rendered by `DashboardPage`
 * only when `count > 0` (this task's Scope: "only shown when the selected customer actually has
 * rewards expiring soon — not hardcoded visible"). `count` is passed in from the same
 * `dashboardSummary.expiringSoon` array the "Expiring soon" stat card reads — see this task's
 * implementation notes on why that one array must be the single source for both, not two
 * independently-worded copies that can drift apart.
 */
import { Link } from 'react-router-dom';
import { Card } from '../../components/Card';
import { AlertTriangleIcon, ArrowRightIcon } from '../../components/icons';

export interface ExpiringRewardsBannerProps {
  count: number;
}

export function ExpiringRewardsBanner({ count }: ExpiringRewardsBannerProps) {
  return (
    <Card role="status" className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-chip bg-warn-soft text-warn-strong"
        >
          <AlertTriangleIcon className="h-5 w-5" />
        </span>
        <p className="font-body text-sm font-semibold text-ink">
          {count} reward{count === 1 ? '' : 's'} expiring soon — use {count === 1 ? 'it' : 'them'}{' '}
          before {count === 1 ? "it's" : "they're"} gone.
        </p>
      </div>
      <Link
        to="/rewards"
        className="inline-flex items-center gap-1 whitespace-nowrap text-sm font-semibold text-accent-strong hover:underline"
      >
        View my rewards
        <ArrowRightIcon className="h-4 w-4" />
      </Link>
    </Card>
  );
}
