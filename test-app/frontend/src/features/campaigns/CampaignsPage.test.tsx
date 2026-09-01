/**
 * T-008 — TC-1: `/campaigns` shows real campaign data with correct status badges.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as apiClient from '../../lib/apiClient';
import { CustomerContext, type CustomerContextValue } from '../../app/useCustomer';
import { CampaignsPage } from './CampaignsPage';
import type { CampaignSummary, Customer } from '../../types';

const PRIYA: Customer = { id: 'priya-shah', displayName: 'Priya Shah', avatarInitials: 'PS' };

function customerValue(): CustomerContextValue {
  return {
    customers: [PRIYA],
    customerId: PRIYA.id,
    customer: PRIYA,
    isLoading: false,
    setCustomerId: () => {},
  };
}

function campaign(overrides: Partial<CampaignSummary>): CampaignSummary {
  return {
    campaignId: 1,
    campaignCode: 'SUMMER_CASHBACK_SPRINT',
    name: 'Summer Cashback Sprint',
    description: 'Earn cashback on every purchase.',
    startDate: '2026-06-01',
    endDate: '2026-08-31',
    status: 'active',
    progress: null,
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CustomerContext.Provider value={customerValue()}>
          <CampaignsPage />
        </CustomerContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CampaignsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('TC-1: renders real campaign data with correct name, dates and status badge', async () => {
    vi.spyOn(apiClient, 'getCampaigns').mockResolvedValue([
      campaign({}),
      campaign({
        campaignId: 3,
        campaignCode: 'WEEKEND_PROMO_BLITZ',
        name: 'Weekend Promo Blitz',
        status: 'completed',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      }),
    ]);
    renderPage();

    expect(await screen.findByText('Summer Cashback Sprint')).toBeInTheDocument();
    expect(screen.getByText('Jun 1 – Aug 31, 2026')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();

    expect(screen.getByText('Weekend Promo Blitz')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
  });

  it('links each campaign row to its own Campaign Detail page', async () => {
    vi.spyOn(apiClient, 'getCampaigns').mockResolvedValue([campaign({})]);
    renderPage();

    const link = await screen.findByRole('link', { name: /Summer Cashback Sprint/ });
    expect(link).toHaveAttribute('href', '/campaigns/SUMMER_CASHBACK_SPRINT');
  });

  it('shows an empty state when there are no campaigns', async () => {
    vi.spyOn(apiClient, 'getCampaigns').mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText('No campaigns to show right now.')).toBeInTheDocument();
  });

  it('shows an error state when the campaigns request fails', async () => {
    vi.spyOn(apiClient, 'getCampaigns').mockRejectedValue(new Error('network down'));
    renderPage();

    expect(await screen.findByText(/Couldn.t load campaigns: network down/)).toBeInTheDocument();
  });
});
