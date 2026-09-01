/**
 * T-007 — the Dashboard page's own test cases (TC-1..TC-8): the expiring-rewards banner only
 * renders when there's actually something expiring soon and its count matches the stat card built
 * from the same array (not two independently-worded copies), stat cards show real
 * `useDashboard` counts, the trackers widget shows real progress/icon per tracker and swaps to the
 * "reward unlocked" state at completion instead of a normal bar, the running-campaigns list shows
 * real name/dates/status, the whole page reacts to a customer switch, and every section stays
 * present in the DOM regardless of viewport (mobile just restacks via CSS, nothing is dropped).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as apiClient from '../../lib/apiClient';
import { CustomerContext, type CustomerContextValue } from '../../app/useCustomer';
import { DashboardPage } from './DashboardPage';
import type { CampaignDetail, Customer, DashboardSummary } from '../../types';

const PRIYA: Customer = { id: 'priya-shah', displayName: 'Priya Shah', avatarInitials: 'PS' };
const MARCUS: Customer = { id: 'marcus-tan', displayName: 'Marcus Tan', avatarInitials: 'MT' };

function customerValue(customer: Customer): CustomerContextValue {
  return {
    customers: [PRIYA, MARCUS],
    customerId: customer.id,
    customer,
    isLoading: false,
    setCustomerId: () => {},
  };
}

function baseSummary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    customerId: 'priya-shah',
    activeCampaigns: [
      {
        campaignId: 1,
        campaignCode: 'SUMMER_CASHBACK_SPRINT',
        campaignName: 'Summer Cashback Sprint',
        startDate: '2026-06-01',
        endDate: '2026-08-31',
        status: 'active',
      },
      {
        campaignId: 3,
        campaignCode: 'WEEKEND_PROMO_BLITZ',
        campaignName: 'Weekend Promo Blitz',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        status: 'active',
      },
    ],
    rewardCounts: { total: 3, unused: 2, used: 1 },
    trackerProgress: [
      {
        campaignId: 1,
        campaignCode: 'SUMMER_CASHBACK_SPRINT',
        campaignName: 'Summer Cashback Sprint',
        trackerId: 10,
        trackerCode: 'SCS_TRACKER',
        trackerName: 'Grocery Streak',
        completionLogic: 'all',
        completedCount: 3,
        threshold: 5,
        completed: false,
      },
      {
        campaignId: 3,
        campaignCode: 'WEEKEND_PROMO_BLITZ',
        campaignName: 'Weekend Promo Blitz',
        trackerId: 30,
        trackerCode: 'WPB_TRACKER',
        trackerName: 'Weekend Spree',
        completionLogic: 'all',
        completedCount: 2,
        threshold: 2,
        completed: true,
      },
    ],
    expiringSoon: [
      {
        id: 'seed-priya-shah-save20',
        customerId: 'priya-shah',
        campaignId: 3,
        campaignCode: 'WEEKEND_PROMO_BLITZ',
        type: 'promo_code',
        value: 'SAVE20',
        currency: null,
        status: 'unused',
        issuedAt: '2026-01-01',
        expiresAt: '2026-01-05',
      },
    ],
    ...overrides,
  };
}

function campaignDetailFor(code: string): CampaignDetail {
  const trackerId = code === 'SUMMER_CASHBACK_SPRINT' ? 10 : 30;
  return {
    campaignId: code === 'SUMMER_CASHBACK_SPRINT' ? 1 : 3,
    campaignCode: code,
    name: code,
    description: null,
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    status: 'active',
    campaignRewards: [],
    trackers: [
      {
        trackerId,
        trackerCode: `${code}_TRACKER`,
        trackerName: 'tracker',
        description: null,
        completionLogic: 'all',
        completionThreshold: null,
        rewards: [
          {
            id: 1,
            level: 'tracker',
            refId: trackerId,
            rewardPolicyId: 1,
            rewardPolicyName: 'policy',
            rewardId: 1,
            rewardName: 'Reward',
            unitType: 'currency',
            unitCode: 'USD',
            amount: '20',
            status: 'active',
          },
        ],
        components: [],
      },
    ],
  };
}

function renderDashboard(customer: Customer = PRIYA) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CustomerContext.Provider value={customerValue(customer)}>
          <DashboardPage />
        </CustomerContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.spyOn(apiClient, 'getCampaign').mockImplementation(async (code) => campaignDetailFor(code));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('TC-1/TC-3: shows the expiring-rewards banner and stat cards from the same real counts', async () => {
    vi.spyOn(apiClient, 'getDashboard').mockResolvedValue(baseSummary());
    renderDashboard();

    const banner = await screen.findByRole('status');
    expect(within(banner).getByText(/1 reward expiring soon/)).toBeInTheDocument();

    expect(screen.getByText('Active campaigns').previousSibling).toHaveTextContent('2');
    expect(screen.getByText('Rewards earned').previousSibling).toHaveTextContent('3');
    // Same underlying `expiringSoon.length` behind both the banner and this stat card.
    expect(screen.getByText('Expiring soon').previousSibling).toHaveTextContent('1');
  });

  it('TC-2: hides the banner entirely when nothing is expiring soon', async () => {
    vi.spyOn(apiClient, 'getDashboard').mockResolvedValue(baseSummary({ expiringSoon: [] }));
    renderDashboard();

    await screen.findByText('Your Progress');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('Expiring soon').previousSibling).toHaveTextContent('0');
  });

  it('TC-4: renders real tracker progress with the correct per-campaign icon', async () => {
    vi.spyOn(apiClient, 'getDashboard').mockResolvedValue(baseSummary());
    renderDashboard();

    await screen.findByText('Grocery Streak');
    expect(screen.getByText('3/5')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Grocery Streak progress' })).toHaveAttribute(
      'aria-valuenow',
      '60',
    );

    // Summer Cashback Sprint's own icon chip (ARCHITECTURE.md §5) — its exact gradient stops.
    const chip = screen.getByText('Grocery Streak').closest('div')
      ?.parentElement?.previousElementSibling;
    expect(chip).toHaveClass('from-[oklch(74%_0.14_55)]');
  });

  it('TC-5: a fully-complete tracker shows the "reward unlocked" state, not a progress bar', async () => {
    vi.spyOn(apiClient, 'getDashboard').mockResolvedValue(baseSummary());
    renderDashboard();

    await screen.findByText('Weekend Spree');
    const row = screen.getByText('Weekend Spree').closest('div')?.parentElement as HTMLElement;
    expect(within(row).getByText('Reward unlocked!')).toBeInTheDocument();
    expect(within(row).queryByRole('progressbar')).not.toBeInTheDocument();

    // The other, still-in-progress tracker keeps its normal bar.
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
  });

  it('TC-6: renders real running-campaign names, formatted dates and status', async () => {
    vi.spyOn(apiClient, 'getDashboard').mockResolvedValue(baseSummary());
    renderDashboard();

    await screen.findByText('Running Campaigns');
    expect(screen.getByText('Summer Cashback Sprint')).toBeInTheDocument();
    expect(screen.getByText('Jun 1 – Aug 31, 2026')).toBeInTheDocument();
    expect(screen.getByText('Weekend Promo Blitz')).toBeInTheDocument();
    expect(screen.getByText('Jan 1 – Dec 31, 2026')).toBeInTheDocument();
    expect(screen.getAllByText('active').length).toBeGreaterThan(0);
  });

  it('TC-7: switching the selected customer updates the whole page to their own real data', async () => {
    const getDashboard = vi.spyOn(apiClient, 'getDashboard').mockImplementation(async (id) =>
      id === 'priya-shah'
        ? baseSummary()
        : baseSummary({
            activeCampaigns: [],
            rewardCounts: { total: 0, unused: 0, used: 0 },
            trackerProgress: [],
            expiringSoon: [],
          }),
    );

    const { rerender } = renderDashboard(PRIYA);
    await screen.findByText('Welcome back, Priya Shah');
    expect(screen.getByText('Active campaigns').previousSibling).toHaveTextContent('2');

    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>
          <CustomerContext.Provider value={customerValue(MARCUS)}>
            <DashboardPage />
          </CustomerContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText('Welcome back, Marcus Tan');
    expect(screen.getByText('Active campaigns').previousSibling).toHaveTextContent('0');
    expect(getDashboard).toHaveBeenCalledWith('marcus-tan');
  });

  it('T-008 regression: shows the real error message instead of an indefinite loading spinner', async () => {
    vi.spyOn(apiClient, 'getDashboard').mockRejectedValue(new Error('tracking-service down'));
    renderDashboard();

    expect(
      await screen.findByText("Couldn't load your dashboard: tracking-service down"),
    ).toBeInTheDocument();
    expect(screen.queryByText('Loading your dashboard…')).not.toBeInTheDocument();
  });

  it('TC-8: every section stays in the document regardless of viewport (no width-based hiding)', async () => {
    vi.spyOn(apiClient, 'getDashboard').mockResolvedValue(baseSummary());
    renderDashboard();

    await screen.findByText('Your Progress');
    expect(screen.getByText('Running Campaigns')).toBeInTheDocument();
    expect(screen.getByText('Active campaigns')).toBeInTheDocument();

    // The stat-card grid and the two-panel section both start single-column and only widen at a
    // breakpoint — never a `hidden`/`md:hidden`-style utility that would remove a whole section
    // from the DOM at some viewport instead of just reflowing it.
    const statGrid = screen.getByText('Active campaigns').closest('.grid');
    expect(statGrid).toHaveClass('grid-cols-1');
    expect(statGrid?.className.split(/\s+/)).not.toContain('hidden');
    const panelGrid = screen.getByText('Your Progress').closest('.glass')?.parentElement;
    expect(panelGrid).toHaveClass('grid-cols-1');
    expect(panelGrid?.className.split(/\s+/)).not.toContain('hidden');
  });
});
