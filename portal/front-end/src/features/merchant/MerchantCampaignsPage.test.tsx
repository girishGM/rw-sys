import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  MerchantCampaignDetail,
  MerchantCampaignListItem,
  MerchantSummary,
} from '@reward-portal/shared';
import { ApiError } from '../../lib/apiError';

const { mockUseMerchantCampaignsQuery, mockUseMerchantCampaignQuery, mockUseMerchantSummaryQuery } =
  vi.hoisted(() => ({
    mockUseMerchantCampaignsQuery: vi.fn(),
    mockUseMerchantCampaignQuery: vi.fn(),
    mockUseMerchantSummaryQuery: vi.fn(),
  }));

vi.mock('./api', () => ({
  useMerchantCampaignsQuery: mockUseMerchantCampaignsQuery,
  useMerchantCampaignQuery: mockUseMerchantCampaignQuery,
  useMerchantSummaryQuery: mockUseMerchantSummaryQuery,
}));

import { MerchantCampaignsPage } from './MerchantCampaignsPage';

const campaignA: MerchantCampaignListItem = {
  id: 1,
  campaignCode: 'CMP-A',
  name: 'Summer Splash',
  description: null,
  region: 'EU',
  startDate: '2026-01-01T00:00:00.000Z',
  endDate: '2026-02-01T00:00:00.000Z',
  status: 'active',
};

const campaignB: MerchantCampaignListItem = {
  id: 2,
  campaignCode: 'CMP-B',
  name: 'Winter Sale',
  description: null,
  region: 'APAC',
  startDate: '2026-03-01T00:00:00.000Z',
  endDate: '2026-04-01T00:00:00.000Z',
  status: 'paused',
};

const detailA: MerchantCampaignDetail = {
  ...campaignA,
  maxParticipants: 5,
  participation: { status: 'active', joinedAt: '2026-01-01T00:00:00.000Z' },
  myActivities: [
    { activityId: 9, activityName: 'In-store purchase', storeId: null, commissionRate: '3.00' },
  ],
};

const summaryUnavailable: MerchantSummary = {
  activeCampaignsCount: 2,
  myActivitiesCount: 3,
  campaignPerformance: { available: false, reason: 'No redemption data source yet' },
  participatingCampaigns: [campaignA, campaignB],
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MerchantCampaignsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUseMerchantCampaignsQuery.mockReset();
  mockUseMerchantCampaignQuery.mockReset();
  mockUseMerchantSummaryQuery.mockReset();
  mockUseMerchantCampaignQuery.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  });
  mockUseMerchantSummaryQuery.mockReturnValue({
    data: summaryUnavailable,
    isLoading: false,
    isError: false,
  });
});

afterEach(() => {
  cleanup();
});

describe('MerchantCampaignsPage', () => {
  it('TC-1 — renders only the campaigns this merchant participates in', () => {
    mockUseMerchantCampaignsQuery.mockReturnValue({
      data: [campaignA, campaignB],
      isLoading: false,
      error: null,
    });

    renderPage();

    expect(screen.getByText('Summer Splash')).toBeInTheDocument();
    expect(screen.getByText('Winter Sale')).toBeInTheDocument();
  });

  it('TC-17 — a friendly empty state when the merchant has zero participations', () => {
    mockUseMerchantCampaignsQuery.mockReturnValue({ data: [], isLoading: false, error: null });

    renderPage();

    expect(screen.getByText('You are not participating in any campaign yet')).toBeInTheDocument();
  });

  it('shows the loading state', () => {
    mockUseMerchantCampaignsQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });

    renderPage();

    expect(screen.getByRole('status', { name: /loading table data/i })).toBeInTheDocument();
  });

  it('shows the server error message when the list fails to load', () => {
    mockUseMerchantCampaignsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new ApiError({ code: 'PERM_DENIED', message: 'You may not view this.', status: 403 }),
    });

    renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent('You may not view this.');
  });

  it('TC-13 — renders the three merchant summary widgets', () => {
    mockUseMerchantCampaignsQuery.mockReturnValue({
      data: [campaignA, campaignB],
      isLoading: false,
      error: null,
    });

    renderPage();

    expect(screen.getByText('Active Campaigns')).toBeInTheDocument();
    expect(screen.getByText('My Activities')).toBeInTheDocument();
    expect(screen.getByText('Campaign Performance')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('TC-19 — an unavailable performance metric renders an honest reason, not a fabricated number', () => {
    mockUseMerchantCampaignsQuery.mockReturnValue({ data: [], isLoading: false, error: null });

    renderPage();

    expect(screen.getByText('No redemption data source yet')).toBeInTheDocument();
    expect(screen.queryByText(/^0$/)).not.toBeInTheDocument();
  });

  it('opens the campaign detail drawer on row click, and shows the participation and activities (TC-8/TC-9)', async () => {
    mockUseMerchantCampaignsQuery.mockReturnValue({
      data: [campaignA],
      isLoading: false,
      error: null,
    });
    mockUseMerchantCampaignQuery.mockReturnValue({
      data: detailA,
      isLoading: false,
      isError: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage();
    await user.click(screen.getByText('Summer Splash'));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/In-store purchase/)).toBeInTheDocument();
    expect(screen.getByText('3.00%')).toBeInTheDocument();
    // Never the campaign's internal budget or another participant's terms — this DTO carries
    // neither field to begin with (TC-8/TC-9), so there is nothing here to accidentally render.
    expect(screen.queryByText(/budget/i)).not.toBeInTheDocument();
  });

  it('closes the drawer', async () => {
    mockUseMerchantCampaignsQuery.mockReturnValue({
      data: [campaignA],
      isLoading: false,
      error: null,
    });
    mockUseMerchantCampaignQuery.mockReturnValue({
      data: detailA,
      isLoading: false,
      isError: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage();
    await user.click(screen.getByText('Summer Splash'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /close panel/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows an empty state inside the drawer when the campaign has no linked activities', async () => {
    mockUseMerchantCampaignsQuery.mockReturnValue({
      data: [campaignA],
      isLoading: false,
      error: null,
    });
    mockUseMerchantCampaignQuery.mockReturnValue({
      data: { ...detailA, myActivities: [] },
      isLoading: false,
      isError: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage();
    await user.click(screen.getByText('Summer Splash'));

    expect(screen.getByText('No activities linked to this campaign yet')).toBeInTheDocument();
  });

  it('shows an error state inside the drawer when the detail request fails (TC-3/TC-4)', async () => {
    mockUseMerchantCampaignsQuery.mockReturnValue({
      data: [campaignA],
      isLoading: false,
      error: null,
    });
    mockUseMerchantCampaignQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError({ code: 'NOT_FOUND', message: 'Not found.', status: 404 }),
    });
    const user = userEvent.setup();

    renderPage();
    await user.click(screen.getByText('Summer Splash'));

    expect(screen.getByText('Could not load this campaign')).toBeInTheDocument();
    expect(screen.getByText('Not found.')).toBeInTheDocument();
  });

  it('renders a status badge for every merchant-visible status', () => {
    mockUseMerchantCampaignsQuery.mockReturnValue({
      data: [
        campaignA,
        campaignB,
        { ...campaignA, id: 3, name: 'Autumn Deal', status: 'completed' },
      ],
      isLoading: false,
      error: null,
    });

    renderPage();

    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('paused')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
  });

  it('renders the summary error state when the summary request fails', () => {
    mockUseMerchantCampaignsQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    mockUseMerchantSummaryQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });

    renderPage();

    expect(screen.getByText('Could not load your dashboard summary')).toBeInTheDocument();
  });

  it('shows the summary strip loading skeletons while the summary request is in flight', () => {
    mockUseMerchantCampaignsQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    mockUseMerchantSummaryQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });

    renderPage();

    // KpiTile's own loading skeleton renders in place of a value; the chart panel's label is
    // still present, its value area replaced by a skeleton too.
    expect(screen.getByText('Active Campaigns')).toBeInTheDocument();
    expect(screen.getByText('Campaign Performance')).toBeInTheDocument();
    expect(screen.queryByText('Not available')).not.toBeInTheDocument();
  });

  it('falls back to "Not available" when the summary has resolved with no data at all', () => {
    mockUseMerchantCampaignsQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    mockUseMerchantSummaryQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    });

    renderPage();

    expect(screen.getByText('Not available')).toBeInTheDocument();
  });

  it('shows the campaign-detail drawer loading skeleton while the detail request is in flight', async () => {
    mockUseMerchantCampaignsQuery.mockReturnValue({
      data: [campaignA],
      isLoading: false,
      error: null,
    });
    mockUseMerchantCampaignQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage();
    await user.click(screen.getByText('Summer Splash'));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText(/In-store purchase/)).not.toBeInTheDocument();
    expect(screen.queryByText('Could not load this campaign')).not.toBeInTheDocument();
  });
});
