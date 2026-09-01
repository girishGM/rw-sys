/**
 * T-009 — TC-1 through TC-6 (TC-7, mobile width, is a real-browser/Playwright concern per this
 * task's completion report, not a jsdom one — see that report's "Verification steps").
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as apiClient from '../../lib/apiClient';
import { CustomerContext, type CustomerContextValue } from '../../app/useCustomer';
import { RewardsPage } from './RewardsPage';
import type { CampaignSummary, Customer, DashboardSummary, RewardLedgerEntry } from '../../types';

const PRIYA: Customer = { id: 'priya-shah', displayName: 'Priya Shah', avatarInitials: 'PS' };

function customerValue(customer: Customer = PRIYA): CustomerContextValue {
  return {
    customers: [customer],
    customerId: customer.id,
    customer,
    isLoading: false,
    setCustomerId: () => {},
  };
}

function reward(overrides: Partial<RewardLedgerEntry>): RewardLedgerEntry {
  return {
    id: 'r1',
    customerId: PRIYA.id,
    campaignId: 1,
    campaignCode: 'SUMMER_CASHBACK_SPRINT',
    type: 'cashback',
    value: '25',
    currency: 'USD',
    status: 'unused',
    issuedAt: '2026-06-05T00:00:00.000Z',
    expiresAt: '2026-08-31',
    ...overrides,
  };
}

function campaign(overrides: Partial<CampaignSummary>): CampaignSummary {
  return {
    campaignId: 1,
    campaignCode: 'SUMMER_CASHBACK_SPRINT',
    name: 'Summer Cashback Sprint',
    description: null,
    startDate: '2026-06-01',
    endDate: '2026-08-31',
    status: 'active',
    progress: null,
    ...overrides,
  };
}

function emptyDashboard(): DashboardSummary {
  return {
    customerId: PRIYA.id,
    activeCampaigns: [],
    rewardCounts: { total: 0, unused: 0, used: 0 },
    trackerProgress: [],
    expiringSoon: [],
  };
}

function mockCommon() {
  vi.spyOn(apiClient, 'getCampaigns').mockResolvedValue([
    campaign({}),
    campaign({
      campaignId: 3,
      campaignCode: 'WEEKEND_PROMO_BLITZ',
      name: 'Weekend Promo Blitz',
    }),
  ]);
  vi.spyOn(apiClient, 'getDashboard').mockResolvedValue(emptyDashboard());
}

function renderPage(customer: Customer = PRIYA) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CustomerContext.Provider value={customerValue(customer)}>
          <RewardsPage />
        </CustomerContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RewardsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('TC-1: groups rewards by type, with the real campaign name and header count', async () => {
    mockCommon();
    vi.spyOn(apiClient, 'getRewards').mockResolvedValue([
      reward({ id: 'cash-1', type: 'cashback', value: '25' }),
      reward({
        id: 'promo-1',
        type: 'promo_code',
        value: 'SAVE20',
        currency: null,
        campaignCode: 'WEEKEND_PROMO_BLITZ',
      }),
    ]);
    renderPage();

    expect(
      await screen.findByText('2 rewards earned across cashback, promo codes and Stripe Points.'),
    ).toBeInTheDocument();

    const cashbackGroup = screen.getByRole('heading', { name: /Cashback/ }).closest('section');
    expect(cashbackGroup).not.toBeNull();
    expect(within(cashbackGroup as HTMLElement).getByText('$25.00')).toBeInTheDocument();
    expect(
      within(cashbackGroup as HTMLElement).getByText('Summer Cashback Sprint'),
    ).toBeInTheDocument();

    const promoGroup = screen.getByRole('heading', { name: /Promo Code/ }).closest('section');
    expect(promoGroup).not.toBeNull();
    expect(within(promoGroup as HTMLElement).getByText('SAVE20')).toBeInTheDocument();
    expect(within(promoGroup as HTMLElement).getByText('Weekend Promo Blitz')).toBeInTheDocument();

    // The "All" tab skips a type this customer has zero of (Stripe Points) rather than showing an
    // empty "Stripe Points" section for it.
    expect(screen.queryByRole('heading', { name: /Stripe Points/ })).not.toBeInTheDocument();
  });

  it('TC-2: filter tabs actually filter the list client-side', async () => {
    mockCommon();
    vi.spyOn(apiClient, 'getRewards').mockResolvedValue([
      reward({ id: 'cash-1', type: 'cashback' }),
      reward({ id: 'promo-1', type: 'promo_code', value: 'SAVE20', currency: null }),
    ]);
    renderPage();

    await screen.findByText('$25.00');
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Cashback' }));

    expect(screen.getByText('$25.00')).toBeInTheDocument();
    expect(screen.queryByText('SAVE20')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'All' }));
    expect(screen.getByText('$25.00')).toBeInTheDocument();
    expect(screen.getByText('SAVE20')).toBeInTheDocument();
  });

  it('TC-3: a customer with zero rewards of a given type shows a sensible empty state for that filter', async () => {
    mockCommon();
    vi.spyOn(apiClient, 'getRewards').mockResolvedValue([
      reward({ id: 'cash-1', type: 'cashback' }),
    ]);
    renderPage();

    await screen.findByText('$25.00');
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Promo Code' }));

    expect(await screen.findByText('No promo codes yet.')).toBeInTheDocument();
  });

  it("TC-4: an unused, soon-expiring reward shows the same expiry badge T-007's dashboard is built from", async () => {
    vi.spyOn(apiClient, 'getCampaigns').mockResolvedValue([campaign({})]);
    const expiring = reward({
      id: 'cash-1',
      type: 'cashback',
      status: 'unused',
      expiresAt: '2026-08-27',
    });
    vi.spyOn(apiClient, 'getDashboard').mockResolvedValue({
      ...emptyDashboard(),
      expiringSoon: [expiring],
    });
    vi.spyOn(apiClient, 'getRewards').mockResolvedValue([expiring]);
    renderPage();

    expect(await screen.findByText('$25.00')).toBeInTheDocument();
    expect(screen.getByText(/Expires (today|in \d+ days?)/)).toBeInTheDocument();
  });

  it('TC-5: a used reward never shows an expiry badge, even if its id is (inconsistently) in expiringSoon', async () => {
    vi.spyOn(apiClient, 'getCampaigns').mockResolvedValue([campaign({})]);
    const used = reward({
      id: 'cash-1',
      type: 'cashback',
      status: 'used',
      expiresAt: '2026-08-27',
    });
    vi.spyOn(apiClient, 'getDashboard').mockResolvedValue({
      ...emptyDashboard(),
      // Defensive fixture: real `routes/dashboard.ts` never includes a `used` reward here, but the
      // card's own guard is asserted directly rather than only indirectly via already-filtered data.
      expiringSoon: [used],
    });
    vi.spyOn(apiClient, 'getRewards').mockResolvedValue([used]);
    renderPage();

    expect(await screen.findByText('$25.00')).toBeInTheDocument();
    expect(screen.getByText('Used')).toBeInTheDocument();
    expect(screen.queryByText(/Expires/)).not.toBeInTheDocument();
  });

  it("TC-6: switching customer re-fetches and shows the new customer's rewards", async () => {
    mockCommon();
    const getRewards = vi.spyOn(apiClient, 'getRewards');
    getRewards.mockResolvedValueOnce([reward({ id: 'priya-r1', value: '25' })]);
    const { rerender } = renderPage(PRIYA);
    expect(await screen.findByText('$25.00')).toBeInTheDocument();

    const MARCUS: Customer = { id: 'marcus-tan', displayName: 'Marcus Tan', avatarInitials: 'MT' };
    getRewards.mockResolvedValueOnce([
      reward({ id: 'marcus-r1', customerId: MARCUS.id, value: '50' }),
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <CustomerContext.Provider value={customerValue(MARCUS)}>
            <RewardsPage />
          </CustomerContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('$50.00')).toBeInTheDocument();
    expect(getRewards).toHaveBeenCalledWith(MARCUS.id);
  });

  it('shows an empty state when the customer has zero rewards of any type', async () => {
    mockCommon();
    vi.spyOn(apiClient, 'getRewards').mockResolvedValue([]);
    renderPage();

    expect(
      await screen.findByText('No rewards yet — complete a tracker to earn your first one.'),
    ).toBeInTheDocument();
  });

  it('shows an error state when the rewards request fails', async () => {
    mockCommon();
    vi.spyOn(apiClient, 'getRewards').mockRejectedValue(new Error('network down'));
    renderPage();

    expect(await screen.findByText(/Couldn.t load your rewards: network down/)).toBeInTheDocument();
  });
});
