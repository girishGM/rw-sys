/**
 * T-039 — TC-20 ("axe scan, zero violations"), following the shape T-045's own
 * `features/trace/a11y.test.tsx` establishes: a genuine `axe-core` scan (already on disk, a
 * transitive dependency of `@storybook/addon-a11y`, hoisted to the workspace root
 * `node_modules/axe-core` by T-021's own `npm install` — see that file's header for the full
 * story of why this is the honest substitute for `npm run test:a11y` in this sandbox) against
 * real, fully-populated renders of every state this feature owns, entirely inside
 * `front-end/src/features/merchant/**` (this task's own file scope).
 *
 * Same one honest caveat that file discloses: jsdom has no real layout/paint engine, so
 * `color-contrast`/`color-contrast-enhanced` cannot be evaluated reliably here and are excluded;
 * every other rule in axe-core's default set runs for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as axe from 'axe-core';
import type {
  MerchantCampaignDetail,
  MerchantCampaignListItem,
  MerchantSummary,
} from '@reward-portal/shared';

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

const JSDOM_LAYOUT_DEPENDENT_RULES = ['color-contrast', 'color-contrast-enhanced'];

async function scan(container: HTMLElement, label: string) {
  const results = await axe.run(container, {
    rules: Object.fromEntries(JSDOM_LAYOUT_DEPENDENT_RULES.map((id) => [id, { enabled: false }])),
  });
  const violations = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target),
  }));
  expect(violations, `${label}: axe-core violations`).toEqual([]);
}

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

const detailA: MerchantCampaignDetail = {
  ...campaignA,
  maxParticipants: 5,
  participation: { status: 'active', joinedAt: '2026-01-01T00:00:00.000Z' },
  myActivities: [
    { activityId: 9, activityName: 'In-store purchase', storeId: null, commissionRate: '3.00' },
  ],
};

const summaryAvailable: MerchantSummary = {
  activeCampaignsCount: 1,
  myActivitiesCount: 1,
  campaignPerformance: { available: true, series: [{ label: 'Jan', value: 4 }] },
  participatingCampaigns: [campaignA],
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
    data: summaryAvailable,
    isLoading: false,
    isError: false,
  });
});

afterEach(() => {
  cleanup();
});

describe('TC-20 — axe-core scan, zero violations', () => {
  it('the loading state has no violations', async () => {
    mockUseMerchantCampaignsQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    const { container } = renderPage();
    await scan(container, 'Loading state');
  });

  it('the populated list has no violations', async () => {
    mockUseMerchantCampaignsQuery.mockReturnValue({
      data: [campaignA],
      isLoading: false,
      error: null,
    });
    const { container } = renderPage();
    await screen.findByText('Summer Splash');
    await scan(container, 'Populated list');
  });

  it('the empty state (TC-17) has no violations', async () => {
    mockUseMerchantCampaignsQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    const { container } = renderPage();
    await screen.findByText('You are not participating in any campaign yet');
    await scan(container, 'Empty state');
  });

  it('the campaign detail drawer, fully populated, has no violations', async () => {
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
    const { container } = renderPage();
    await user.click(screen.getByText('Summer Splash'));
    await screen.findByText(/In-store purchase/);
    await scan(container, 'Campaign detail drawer');
  });

  it('the "not available" performance state (TC-19) has no violations', async () => {
    mockUseMerchantCampaignsQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    mockUseMerchantSummaryQuery.mockReturnValue({
      data: {
        ...summaryAvailable,
        campaignPerformance: { available: false, reason: 'No source table yet' },
      },
      isLoading: false,
      isError: false,
    });
    const { container } = renderPage();
    await screen.findByText('No source table yet');
    await scan(container, 'Performance not-available state');
  });
});
