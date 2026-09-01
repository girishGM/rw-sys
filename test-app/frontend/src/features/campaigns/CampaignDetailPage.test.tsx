/**
 * T-008 — the Campaign Detail page's own test cases (TC-2, TC-3, TC-4, TC-5, TC-6, TC-8): the
 * hero banner uses the real per-campaign gradient, a partially-complete `all`-logic tracker shows
 * correct per-component state and "Requires ALL" copy, a fully-complete tracker's reward shows
 * "Earned" while a not-yet-qualifying customer's same tracker shows "Not yet earned", an unknown
 * `:code` renders a not-found state (no crash), and every section stays in the DOM regardless of
 * viewport. TC-1/TC-7 (mockup match / mobile screenshot) and TC-1/TC-3 of the shell's own
 * verification steps are exercised live, per this task's completion report.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as apiClient from '../../lib/apiClient';
import { ApiError } from '../../lib/apiClient';
import { CustomerContext, type CustomerContextValue } from '../../app/useCustomer';
import { CampaignDetailPage } from './CampaignDetailPage';
import type { CampaignDetail, CampaignSummary, Customer } from '../../types';

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

function summerDetail(completedCount: 1 | 3): CampaignDetail {
  return {
    campaignId: 1,
    campaignCode: 'SUMMER_CASHBACK_SPRINT',
    name: 'Summer Cashback Sprint',
    description: 'Earn cashback on every purchase this summer.',
    startDate: '2026-06-01',
    endDate: '2026-08-31',
    status: 'active',
    campaignRewards: [],
    trackers: [
      {
        trackerId: 10,
        trackerCode: 'SCS_TRACKER',
        trackerName: 'Grocery Streak',
        description: null,
        completionLogic: 'all',
        completionThreshold: null,
        rewards: [
          {
            id: 1,
            level: 'tracker',
            refId: 10,
            rewardPolicyId: 1,
            rewardPolicyName: 'policy',
            rewardId: 1,
            rewardName: 'Grocery Cashback',
            unitType: 'currency',
            unitCode: 'USD',
            amount: '20',
            status: 'active',
          },
        ],
        components: [
          {
            componentId: 1,
            componentCode: 'C1',
            componentName: 'First purchase',
            activityName: null,
            sequenceOrder: 1,
            isMandatory: true,
            completed: true,
          },
          {
            componentId: 2,
            componentCode: 'C2',
            componentName: 'Second purchase',
            activityName: null,
            sequenceOrder: 2,
            isMandatory: true,
            completed: completedCount === 3,
          },
          {
            componentId: 3,
            componentCode: 'C3',
            componentName: 'Third purchase',
            activityName: null,
            sequenceOrder: 3,
            isMandatory: true,
            completed: completedCount === 3,
          },
        ],
      },
    ],
  };
}

function summerSummary(completedCount: 1 | 3): CampaignSummary {
  return {
    campaignId: 1,
    campaignCode: 'SUMMER_CASHBACK_SPRINT',
    name: 'Summer Cashback Sprint',
    description: null,
    startDate: '2026-06-01',
    endDate: '2026-08-31',
    status: 'active',
    progress: {
      trackers: [
        {
          trackerId: 10,
          trackerCode: 'SCS_TRACKER',
          trackerName: 'Grocery Streak',
          completionLogic: 'all',
          completedCount,
          threshold: 3,
          completed: completedCount === 3,
        },
      ],
    },
  };
}

function renderAt(path: string, customer: Customer = PRIYA) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <CustomerContext.Provider value={customerValue(customer)}>
          <Routes>
            <Route path="/campaigns/:code" element={<CampaignDetailPage />} />
          </Routes>
        </CustomerContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CampaignDetailPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('TC-2: renders the correct hero gradient for the campaign', async () => {
    vi.spyOn(apiClient, 'getCampaign').mockResolvedValue(summerDetail(1));
    vi.spyOn(apiClient, 'getCampaigns').mockResolvedValue([summerSummary(1)]);
    renderAt('/campaigns/SUMMER_CASHBACK_SPRINT');

    const heading = await screen.findByRole('heading', { name: 'Summer Cashback Sprint' });
    const hero = heading.closest('div')?.parentElement;
    expect(hero).toHaveClass('from-[oklch(74%_0.14_55)]');
    expect(hero).toHaveClass('to-[oklch(65%_0.18_30)]');
  });

  it('TC-3: a partially-complete `all`-logic tracker shows correct per-component state and "Requires ALL" copy', async () => {
    vi.spyOn(apiClient, 'getCampaign').mockResolvedValue(summerDetail(1));
    vi.spyOn(apiClient, 'getCampaigns').mockResolvedValue([summerSummary(1)]);
    renderAt('/campaigns/SUMMER_CASHBACK_SPRINT');

    await screen.findByText('Grocery Streak');
    expect(screen.getByText('Requires ALL components')).toBeInTheDocument();
    expect(screen.getByText('1/3')).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: 'Grocery Streak progress' }),
    ).toBeInTheDocument();
    expect(screen.getByText('First purchase')).toBeInTheDocument();
    expect(screen.getByText('Second purchase')).toBeInTheDocument();
  });

  it('TC-4: a fully-complete tracker shows the reward card as "Earned"', async () => {
    vi.spyOn(apiClient, 'getCampaign').mockResolvedValue(summerDetail(3));
    vi.spyOn(apiClient, 'getCampaigns').mockResolvedValue([summerSummary(3)]);
    renderAt('/campaigns/SUMMER_CASHBACK_SPRINT');

    await screen.findByText('Grocery Streak');
    expect(screen.getByText('Earned')).toBeInTheDocument();
    expect(screen.queryByText('Not yet earned')).not.toBeInTheDocument();
    expect(screen.getByText('$20.00')).toBeInTheDocument();
    expect(screen.getByText('Complete')).toBeInTheDocument();
  });

  it('TC-5: the same tracker shows "Not yet earned" for a different, not-yet-qualifying customer', async () => {
    vi.spyOn(apiClient, 'getCampaign').mockImplementation(async (_code, customerId) =>
      customerId === 'priya-shah' ? summerDetail(3) : summerDetail(1),
    );
    vi.spyOn(apiClient, 'getCampaigns').mockImplementation(async (customerId) => [
      customerId === 'priya-shah' ? summerSummary(3) : summerSummary(1),
    ]);

    const { rerender } = renderAt('/campaigns/SUMMER_CASHBACK_SPRINT', PRIYA);
    await screen.findByText('Earned');

    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter initialEntries={['/campaigns/SUMMER_CASHBACK_SPRINT']}>
          <CustomerContext.Provider value={customerValue(MARCUS)}>
            <Routes>
              <Route path="/campaigns/:code" element={<CampaignDetailPage />} />
            </Routes>
          </CustomerContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Not yet earned')).toBeInTheDocument();
    expect(screen.queryByText('Earned')).not.toBeInTheDocument();
  });

  it('TC-6: an unknown campaign code renders a not-found state instead of crashing', async () => {
    vi.spyOn(apiClient, 'getCampaign').mockRejectedValue(
      new ApiError('unknown campaign code "NOPE"', 404),
    );
    vi.spyOn(apiClient, 'getCampaigns').mockResolvedValue([]);
    renderAt('/campaigns/NOPE');

    expect(await screen.findByText('Campaign not found')).toBeInTheDocument();
    expect(screen.getByText(/no campaign with the code "NOPE"/)).toBeInTheDocument();
  });

  it('TC-8: the "Back to Campaigns" link points back to /campaigns', async () => {
    vi.spyOn(apiClient, 'getCampaign').mockResolvedValue(summerDetail(1));
    vi.spyOn(apiClient, 'getCampaigns').mockResolvedValue([summerSummary(1)]);
    renderAt('/campaigns/SUMMER_CASHBACK_SPRINT');

    await screen.findByText('Grocery Streak');
    expect(screen.getByRole('link', { name: /Back to Campaigns/ })).toHaveAttribute(
      'href',
      '/campaigns',
    );
  });

  it('renders every section in the DOM regardless of viewport (no width-based hiding)', async () => {
    vi.spyOn(apiClient, 'getCampaign').mockResolvedValue(summerDetail(1));
    vi.spyOn(apiClient, 'getCampaigns').mockResolvedValue([summerSummary(1)]);
    renderAt('/campaigns/SUMMER_CASHBACK_SPRINT');

    const heading = await screen.findByRole('heading', { name: 'Summer Cashback Sprint' });
    expect(heading).toBeInTheDocument();
    expect(screen.getByText('About this campaign')).toBeInTheDocument();
    const trackersHeading = screen.getByText('Trackers');
    expect(
      within(trackersHeading.closest('.glass') as HTMLElement).getByText('Grocery Streak'),
    ).toBeInTheDocument();
  });
});
