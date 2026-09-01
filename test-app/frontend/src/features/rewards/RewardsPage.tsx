/**
 * T-009 — the My Rewards page (`/rewards`, `ARCHITECTURE.md` §4), replacing `router.tsx`'s T-006
 * placeholder: page header with total count, functional filter tabs (All / Cashback / Promo Code
 * / Stripe Points — actually filtering the list client-side, TC-2), rewards grouped by type
 * (TC-1), a sensible empty state per filter (TC-3), and an expiry countdown badge on anything
 * unused and within T-007's own expiring-soon window (TC-4/TC-5).
 *
 * Combines 3 real queries for one customer: `useRewards` (`GET /api/rewards` — the full ledger,
 * unfiltered, this page's own job to group per `routes/rewards.ts`'s doc comment), `useDashboard`
 * (`GET /api/dashboard` — read only for its `expiringSoon` list, the exact same server-computed
 * set T-007's banner/stat card use, so this page's badges can never disagree with that page for
 * the same customer) and `useCampaigns` (`GET /api/campaigns` — resolves each reward's
 * `campaignCode` to its real, human-readable campaign name). The page's own loading/error gate is
 * driven by `useRewards` alone (the data this page cannot render anything meaningful without);
 * `useDashboard`/`useCampaigns` are treated as best-effort enrichment — if either is slow or
 * fails, the page still renders every reward, just without a resolved campaign name (falls back
 * to the raw code) or without an expiry badge, rather than blocking the whole page on a query
 * this page doesn't strictly need to progress past its loading state.
 */
import { useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';
import { useCustomer } from '../../app/useCustomer';
import { useCampaigns, useDashboard, useRewards } from '../../lib/queries';
import { Card } from '../../components/Card';
import { REWARD_TYPES, type RewardType } from '../../types';
import { groupRewardsByType } from './groupRewardsByType';
import { RewardTypeGroup } from './RewardTypeGroup';

type FilterKey = 'all' | RewardType;

const FILTERS: readonly { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'cashback', label: 'Cashback' },
  { key: 'promo_code', label: 'Promo Code' },
  { key: 'points', label: 'Stripe Points' },
];

// T-011: Radix `Tabs.Trigger` only marks the *selected* tab via `data-[state=active]`, which
// has nothing to do with keyboard focus — arrow-key/Tab focus onto an unselected tab produced no
// visible indicator at all before `focus-visible:ring` was added here.
const TAB_TRIGGER_CLASS =
  'flex min-h-[44px] items-center justify-center whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold text-ink-muted outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-accent data-[state=active]:bg-accent-soft data-[state=active]:text-accent-strong';

function RewardsPageShell({ children, totalCount }: { children: ReactNode; totalCount?: number }) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-ink sm:text-[28px]">My Rewards</h1>
        <p className="font-body text-sm text-ink-muted">
          {totalCount === undefined
            ? "Every reward you've earned across cashback, promo codes and Stripe Points."
            : `${totalCount} reward${totalCount === 1 ? '' : 's'} earned across cashback, promo codes and Stripe Points.`}
        </p>
      </div>
      {children}
    </div>
  );
}

export function RewardsPage() {
  const { customerId, isLoading: customerLoading } = useCustomer();
  const rewardsQuery = useRewards(customerId);
  const dashboardQuery = useDashboard(customerId);
  const campaignsQuery = useCampaigns(customerId);
  const [activeFilter, setActiveFilter] = useState<FilterKey>('all');

  if (customerLoading || rewardsQuery.isLoading || !rewardsQuery.data) {
    // `rewardsQuery.isError` is checked *inside* this branch, not as a separate `if` after it —
    // an errored query's `data` stays `undefined` forever, so a later, sibling `if
    // (rewardsQuery.isError)` would never be reached (this same T-007/T-008 pattern, this task's
    // own agent already owns both of those files too).
    if (rewardsQuery.isError) {
      return (
        <RewardsPageShell>
          <Card className="p-6">
            <p className="font-body text-sm text-warn-strong">
              Couldn&apos;t load your rewards: {rewardsQuery.error.message}
            </p>
          </Card>
        </RewardsPageShell>
      );
    }
    return (
      <RewardsPageShell>
        <Card className="p-6" aria-busy="true">
          <p className="font-body text-sm text-ink-muted">Loading your rewards…</p>
        </Card>
      </RewardsPageShell>
    );
  }

  const rewards = rewardsQuery.data;
  const grouped = groupRewardsByType(rewards);
  const expiringSoonIds = new Set((dashboardQuery.data?.expiringSoon ?? []).map((r) => r.id));
  const campaignNameByCode = new Map(
    (campaignsQuery.data ?? []).map((campaign) => [campaign.campaignCode, campaign.name]),
  );

  return (
    <RewardsPageShell totalCount={rewards.length}>
      {rewards.length === 0 ? (
        <Card className="p-6">
          <p className="font-body text-sm text-ink-muted">
            No rewards yet — complete a tracker to earn your first one.
          </p>
        </Card>
      ) : (
        <Tabs.Root
          value={activeFilter}
          onValueChange={(value) => setActiveFilter(value as FilterKey)}
        >
          <Tabs.List
            aria-label="Filter rewards by type"
            className="glass inline-flex flex-wrap gap-1 rounded-full p-1.5"
          >
            {FILTERS.map((filter) => (
              <Tabs.Trigger key={filter.key} value={filter.key} className={TAB_TRIGGER_CLASS}>
                {filter.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          {FILTERS.map((filter) => {
            // The "All" tab groups by every type but skips a type with zero rewards outright
            // (there's no need for a "No X yet" card when the other, non-empty groups already
            // make clear this customer simply doesn't have that type) — a single filter tab
            // (e.g. "Promo Code") always renders its one group, empty state included, so
            // selecting it always shows *something* explaining why the list is blank (TC-3).
            const typesToShow =
              filter.key === 'all'
                ? REWARD_TYPES.filter((type) => grouped[type].length > 0)
                : [filter.key as RewardType];

            return (
              <Tabs.Content
                key={filter.key}
                value={filter.key}
                className="mt-6 flex flex-col gap-6"
              >
                {typesToShow.map((type) => (
                  <RewardTypeGroup
                    key={type}
                    type={type}
                    rewards={grouped[type]}
                    campaignNameByCode={campaignNameByCode}
                    expiringSoonIds={expiringSoonIds}
                  />
                ))}
              </Tabs.Content>
            );
          })}
        </Tabs.Root>
      )}
    </RewardsPageShell>
  );
}
