/**
 * T-007 — the real Dashboard page (`/`, `ARCHITECTURE.md` §4), replacing `router.tsx`'s T-006
 * placeholder: welcome heading, the expiring-rewards alert banner (only when the selected
 * customer actually has rewards expiring soon), 3 stat cards, the "Your Progress" trackers
 * widget, and the "Running Campaigns" list — all driven by one `useDashboard(customerId)` call
 * (`GET /api/dashboard`, T-004's own aggregate endpoint built for exactly this page).
 *
 * Responsive per `UI-UX-DESIGN.md`: a single column on mobile, a 2-column split (trackers wider,
 * campaigns narrower) from the `lg` breakpoint up — every section always renders in the DOM
 * regardless of viewport (nothing is conditionally hidden by width), so nothing silently drops on
 * mobile (this task's TC-8, a real bug the mockup review caught once already).
 */
import { useCustomer } from '../../app/useCustomer';
import { useDashboard } from '../../lib/queries';
import { Card } from '../../components/Card';
import { CalendarCheckIcon, ClockIcon, GiftIcon } from '../../components/icons';
import { StatCard } from './StatCard';
import { ExpiringRewardsBanner } from './ExpiringRewardsBanner';
import { TrackersWidget } from './TrackersWidget';
import { RunningCampaignsList } from './RunningCampaignsList';

export function DashboardPage() {
  const { customer, customerId, isLoading: customerLoading } = useCustomer();
  const dashboardQuery = useDashboard(customerId);

  if (customerLoading || dashboardQuery.isLoading || !dashboardQuery.data) {
    // T-008 fix — `dashboardQuery.isError` must be checked *inside* this branch, not as a
    // separate `if` after it: an errored query's `data` stays `undefined` forever, so a later,
    // sibling `if (dashboardQuery.isError)` was unreachable dead code — a real customer-visible
    // bug (an indefinite "Loading your dashboard…" spinner instead of the intended error message)
    // found while building the identical loading/error gate for `features/campaigns/CampaignsPage`
    // (T-008) and fixed here too, since it's the exact same pattern in the same file scope
    // (`test-app/frontend/**`) and this task's own agent already owns both. See T-008's completion
    // report for how this was found (a real, reproducible test, not a hypothetical).
    if (dashboardQuery.isError) {
      return (
        <Card className="p-6">
          <p className="font-body text-sm text-warn-strong">
            Couldn&apos;t load your dashboard: {dashboardQuery.error.message}
          </p>
        </Card>
      );
    }
    return (
      <Card className="p-6" aria-busy="true">
        <p className="font-body text-sm text-ink-muted">Loading your dashboard…</p>
      </Card>
    );
  }

  const summary = dashboardQuery.data;
  // The single source both the banner's copy and the "Expiring soon" stat card read — see
  // `ExpiringRewardsBanner`'s own header for why these must never be two independent numbers.
  const expiringCount = summary.expiringSoon.length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-ink sm:text-[28px]">
          Welcome back{customer ? `, ${customer.displayName}` : ''}
        </h1>
        <p className="font-body text-sm text-ink-muted">
          Here&apos;s where your rewards stand today.
        </p>
      </div>

      {expiringCount > 0 && <ExpiringRewardsBanner count={expiringCount} />}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          icon={CalendarCheckIcon}
          label="Active campaigns"
          value={summary.activeCampaigns.length}
        />
        <StatCard icon={GiftIcon} label="Rewards earned" value={summary.rewardCounts.total} />
        <StatCard
          icon={ClockIcon}
          label="Expiring soon"
          value={expiringCount}
          tone={expiringCount > 0 ? 'warn' : 'accent'}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[3fr_2fr]">
        <TrackersWidget trackers={summary.trackerProgress} customerId={customerId} />
        <RunningCampaignsList campaigns={summary.activeCampaigns} />
      </div>
    </div>
  );
}
