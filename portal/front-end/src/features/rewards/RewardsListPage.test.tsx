import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RewardListItem } from '@reward-portal/shared';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';

const {
  mockUseRewardsQuery,
  mockFetchRewardCountries,
  mockUseRewardCategoriesQuery,
  mockUseRewardSubCategoriesQuery,
} = vi.hoisted(() => ({
  mockUseRewardsQuery: vi.fn(),
  mockFetchRewardCountries: vi.fn(),
  mockUseRewardCategoriesQuery: vi.fn(),
  mockUseRewardSubCategoriesQuery: vi.fn(),
}));

vi.mock('./api', () => ({
  useRewardsQuery: mockUseRewardsQuery,
  fetchRewardCountries: mockFetchRewardCountries,
  rewardCountriesQueryKey: (id: number) => ['rewards', id, 'countries'],
}));
vi.mock('./rewardValue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rewardValue')>()),
  useRewardCategoriesQuery: mockUseRewardCategoriesQuery,
  useRewardSubCategoriesQuery: mockUseRewardSubCategoriesQuery,
}));
vi.mock('./AddRewardModal', () => ({
  AddRewardModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-reward-modal" /> : null,
}));

import { RewardsListPage } from './RewardsListPage';

const CATEGORIES = [
  { id: 7, categoryCode: 'CASHBACK', name: 'Cashback', status: 'active' },
  { id: 8, categoryCode: 'POINTS', name: 'Points', status: 'active' },
];
const SUB_CATEGORIES = [
  { id: 21, categoryId: 7, subCategoryCode: 'INSTANT', name: 'Instant', status: 'active' },
  { id: 22, categoryId: 7, subCategoryCode: 'DELAYED', name: 'Delayed', status: 'active' },
];

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
    categoryId: 7,
    categoryName: 'Cashback',
    subCategoryId: 21,
    subCategoryName: 'Instant',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const rewards: RewardListItem[] = [
  rewardRow({ id: 1, systemCode: 'CASHBACK_STANDARD', name: 'Standard cashback' }),
  rewardRow({
    id: 2,
    systemCode: 'POINTS_TIER',
    name: 'Points tier',
    status: 'inactive',
    categoryId: 8,
    categoryName: 'Points',
    subCategoryId: null,
    subCategoryName: null,
  }),
];

function countryAssignment(countryId: number) {
  return {
    id: countryId,
    rewardId: 1,
    countryId,
    countryCode: `C${String(countryId)}`,
    countryName: `Country ${String(countryId)}`,
    assignedAt: '2026-01-01T00:00:00.000Z',
    assignedBy: null,
  };
}

function bootstrapValue(canCreate: boolean, canViewAssignments = true): BootstrapContextValue {
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
    hasPermission: (entity, action) => {
      if (entity === 'reward' && action === 'create') return canCreate;
      if (entity === 'reward_assignment' && action === 'view') return canViewAssignments;
      return true;
    },
    refetch: () => undefined,
  };
}

function renderPage(canCreate: boolean, canViewAssignments = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(canCreate, canViewAssignments)}>
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

/** The row `<tr>` a reward's name appears in, so a column assertion cannot accidentally match
 * another row's cell. */
function rowFor(name: string): HTMLElement {
  return screen.getByText(name).closest('tr') as HTMLElement;
}

beforeEach(() => {
  mockUseRewardsQuery.mockReset();
  mockFetchRewardCountries.mockReset();
  mockUseRewardCategoriesQuery.mockReset();
  mockUseRewardSubCategoriesQuery.mockReset();

  mockFetchRewardCountries.mockResolvedValue([]);
  mockUseRewardCategoriesQuery.mockReturnValue({ data: CATEGORIES, isLoading: false });
  mockUseRewardSubCategoriesQuery.mockReturnValue({ data: SUB_CATEGORIES, isLoading: false });
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

  it('TC-4: filtering by category, then by sub-category, narrows the rows shown', async () => {
    mockUseRewardsQuery.mockReturnValue({
      data: { data: rewards, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();
    renderPage(true);

    await user.click(screen.getByRole('combobox', { name: /^category$/i }));
    await user.click(screen.getByRole('option', { name: 'Cashback' }));

    expect(screen.getByText('Standard cashback')).toBeInTheDocument();
    expect(screen.queryByText('Points tier')).not.toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: /sub-category/i }));
    await user.click(screen.getByRole('option', { name: 'Delayed' }));

    // 'Delayed' (22) belongs to Cashback but to no row — both rows are now filtered out.
    expect(screen.queryByText('Standard cashback')).not.toBeInTheDocument();
    expect(screen.getByText('No rewards match these filters')).toBeInTheDocument();
  });

  it('leaves the sub-category picker disabled until a category is chosen', () => {
    mockUseRewardsQuery.mockReturnValue({
      data: { data: rewards, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });
    renderPage(true);

    expect(screen.getByRole('combobox', { name: /sub-category/i })).toBeDisabled();
  });

  it('sends the status filter to the server — it is a real query parameter', async () => {
    mockUseRewardsQuery.mockReturnValue({
      data: { data: rewards, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();
    renderPage(true);

    await user.click(screen.getByRole('combobox', { name: /status/i }));
    await user.click(screen.getByRole('option', { name: 'Inactive' }));

    const lastCall = mockUseRewardsQuery.mock.calls.at(-1)?.[0] as { status?: string };
    expect(lastCall.status).toBe('inactive');
  });

  it('searches code and name on the rows shown', async () => {
    mockUseRewardsQuery.mockReturnValue({
      data: { data: rewards, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();
    renderPage(true);

    await user.type(screen.getByPlaceholderText(/search by code or name/i), 'POINTS_');
    await user.click(screen.getByRole('button', { name: /^search$/i }));

    expect(screen.getByText('Points tier')).toBeInTheDocument();
    expect(screen.queryByText('Standard cashback')).not.toBeInTheDocument();
  });

  it('TC-5: a reward assigned to 2 countries reads "2 countries", not "Not assigned"', async () => {
    mockUseRewardsQuery.mockReturnValue({
      data: { data: rewards, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });
    mockFetchRewardCountries.mockImplementation((rewardId: number) =>
      Promise.resolve(rewardId === 1 ? [countryAssignment(10), countryAssignment(11)] : []),
    );

    renderPage(true);

    await waitFor(() => {
      expect(within(rowFor('Standard cashback')).getByText('2 countries')).toBeInTheDocument();
    });
    expect(within(rowFor('Points tier')).getByText('Not assigned')).toBeInTheDocument();
  });

  it('says "1 country", not "1 countries", for a single assignment', async () => {
    mockUseRewardsQuery.mockReturnValue({
      data: { data: [rewards[0]!], meta: { page: 1, pageSize: 20, total: 1 } },
      isLoading: false,
      error: null,
    });
    mockFetchRewardCountries.mockResolvedValue([countryAssignment(10)]);

    renderPage(true);

    await waitFor(() => {
      expect(within(rowFor('Standard cashback')).getByText('1 country')).toBeInTheDocument();
    });
  });

  it('hides the Countries column — and never calls the endpoint — without reward_assignment:view', async () => {
    mockUseRewardsQuery.mockReturnValue({
      data: { data: rewards, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });

    renderPage(false, false);

    expect(screen.queryByRole('columnheader', { name: /countries/i })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mockFetchRewardCountries).not.toHaveBeenCalled();
    });
  });

  it('shows the category and sub-category of each row', () => {
    mockUseRewardsQuery.mockReturnValue({
      data: { data: rewards, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });

    renderPage(true);

    expect(within(rowFor('Standard cashback')).getByText('Cashback')).toBeInTheDocument();
    expect(within(rowFor('Standard cashback')).getByText('Instant')).toBeInTheDocument();
    // A category may legitimately have no sub-category (T-116's "Points never needs one").
    expect(within(rowFor('Points tier')).getByText('—')).toBeInTheDocument();
  });
});
