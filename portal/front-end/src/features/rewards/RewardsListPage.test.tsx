import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RewardListItem } from '@reward-portal/shared';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';

const { mockUseRewardsQuery } = vi.hoisted(() => ({ mockUseRewardsQuery: vi.fn() }));

vi.mock('./api', () => ({ useRewardsQuery: mockUseRewardsQuery }));
vi.mock('./AddRewardModal', () => ({
  AddRewardModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-reward-modal" /> : null,
}));

import { RewardsListPage } from './RewardsListPage';

function rewardRow(overrides: Partial<RewardListItem> = {}): RewardListItem {
  return {
    id: 1,
    systemCode: 'CASHBACK_STANDARD',
    name: 'Standard cashback',
    description: null,
    rewardType: 'monetary',
    deliveryMode: 'realtime',
    connectorType: 'internal_api',
    maintenanceWindowEnabled: false,
    maintenanceSchedule: {},
    retryEnabled: true,
    retryConfig: {},
    merchantId: null,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const rewards: RewardListItem[] = [
  rewardRow({ id: 1, systemCode: 'CASHBACK_STANDARD', name: 'Standard cashback' }),
  rewardRow({ id: 2, systemCode: 'POINTS_TIER', name: 'Points tier', status: 'inactive' }),
];

function bootstrapValue(canCreate: boolean): BootstrapContextValue {
  return {
    user: { id: 1, displayName: 'Test User', role: 'super_admin', locale: 'en', timezone: null },
    scope: { countryId: null, tenantId: null, merchantId: null },
    nav: [],
    permissions: {},
    widgets: [],
    messages: {},
    isLoading: false,
    isError: false,
    isUnauthorized: false,
    hasPermission: (entity, action) =>
      entity === 'reward' && action === 'create' ? canCreate : true,
    refetch: () => undefined,
  };
}

function renderPage(canCreate: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(canCreate)}>
        <MemoryRouter initialEntries={['/rewards']}>
          <Routes>
            <Route path="/rewards" element={<RewardsListPage />} />
            <Route path="/rewards/:id" element={<div>Reward detail screen</div>} />
          </Routes>
        </MemoryRouter>
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUseRewardsQuery.mockReset();
});

describe('RewardsListPage', () => {
  it('renders every reward row', () => {
    mockUseRewardsQuery.mockReturnValue({
      data: { data: rewards, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });

    renderPage(true);

    expect(screen.getByText('Standard cashback')).toBeInTheDocument();
    expect(screen.getByText('Points tier')).toBeInTheDocument();
  });

  it('shows "Add reward" for a caller holding reward:create (super_admin)', () => {
    mockUseRewardsQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });

    renderPage(true);
    expect(screen.getByRole('button', { name: /add reward/i })).toBeInTheDocument();
  });

  it('TC-19: hides "Add reward" for a caller without reward:create (e.g. maker) — read-only', () => {
    mockUseRewardsQuery.mockReturnValue({
      data: { data: rewards, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });

    renderPage(false);
    expect(screen.queryByRole('button', { name: /add reward/i })).not.toBeInTheDocument();
    expect(screen.getByText('Standard cashback')).toBeInTheDocument();
  });

  it('opens the Add Reward modal when the button is clicked', async () => {
    mockUseRewardsQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByRole('button', { name: /add reward/i }));

    expect(screen.getByTestId('add-reward-modal')).toBeInTheDocument();
  });

  it('navigates to the reward detail screen when a row is clicked', async () => {
    mockUseRewardsQuery.mockReturnValue({
      data: { data: rewards, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByText('Standard cashback'));

    await waitFor(() => {
      expect(screen.getByText('Reward detail screen')).toBeInTheDocument();
    });
  });

  it('renders an empty state when there are no rewards', () => {
    mockUseRewardsQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });

    renderPage(true);
    expect(screen.getByText('No rewards yet')).toBeInTheDocument();
  });

  it('shows the loading state', () => {
    mockUseRewardsQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderPage(true);
    expect(screen.getByRole('status', { name: /loading table data/i })).toBeInTheDocument();
  });

  it('shows the server error message when the list fails to load', () => {
    mockUseRewardsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new ApiError({ code: 'PERM_DENIED', message: 'You may not view this.', status: 403 }),
    });
    renderPage(true);
    expect(screen.getByRole('alert')).toHaveTextContent('You may not view this.');
  });

  it('re-requests the next page', async () => {
    mockUseRewardsQuery.mockReturnValue({
      data: { data: rewards, meta: { page: 1, pageSize: 1, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByRole('button', { name: /^next$/i }));

    const lastCall = mockUseRewardsQuery.mock.calls.at(-1)?.[0] as { page: number };
    expect(lastCall.page).toBe(2);
  });

  it('toggles sort direction on repeated header clicks, resetting back to page 1', async () => {
    mockUseRewardsQuery.mockReturnValue({
      data: { data: rewards, meta: { page: 1, pageSize: 1, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);

    const sortButton = screen.getByRole('columnheader', { name: /code/i }).querySelector('button')!;
    await user.click(sortButton);
    await user.click(sortButton);

    const lastCall = mockUseRewardsQuery.mock.calls.at(-1)?.[0] as {
      page: number;
      sort: string;
    };
    expect(lastCall.sort).toBe('systemCode:desc');
    expect(lastCall.page).toBe(1);
  });
});
