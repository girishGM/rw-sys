import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { rewardSchema, type Reward } from '@reward-portal/shared';
import { ApiError } from '../../lib/apiError';

const {
  mockUseCountriesQuery,
  mockUseRewardCountriesQuery,
  mockAssignMutateAsync,
  mockUseAssignRewardCountryMutation,
  mockUnassignMutateAsync,
  mockUseUnassignRewardCountryMutation,
} = vi.hoisted(() => ({
  mockUseCountriesQuery: vi.fn(),
  mockUseRewardCountriesQuery: vi.fn(),
  mockAssignMutateAsync: vi.fn(),
  mockUseAssignRewardCountryMutation: vi.fn(),
  mockUnassignMutateAsync: vi.fn(),
  mockUseUnassignRewardCountryMutation: vi.fn(),
}));

vi.mock('../countries/api', () => ({ useCountriesQuery: mockUseCountriesQuery }));
vi.mock('./api', () => ({
  useRewardCountriesQuery: mockUseRewardCountriesQuery,
  useAssignRewardCountryMutation: mockUseAssignRewardCountryMutation,
  useUnassignRewardCountryMutation: mockUseUnassignRewardCountryMutation,
}));

import { AssignCountriesModal } from './AssignCountriesModal';

/** T-133 — carries the four category fields T-118 made part of every `/rewards` response.
 * This modal never parses the reward itself, so nothing here fails at runtime when the fixture
 * drifts; the contract case at the bottom of this file is what makes that drift visible to
 * `npm test` rather than only to `tsc`. */
const reward: Reward = {
  id: 1,
  systemCode: 'CASHBACK_STANDARD',
  name: 'Standard cashback',
  description: null,
  rewardType: 'monetary',
  deliveryMode: 'realtime',
  connectorType: 'internal_api',
  connectorConfigPreview: null,
  maintenanceWindowEnabled: false,
  maintenanceSchedule: {},
  retryEnabled: true,
  retryConfig: {},
  merchantId: null,
  categoryId: 4,
  categoryName: 'Cashback',
  subCategoryId: null,
  subCategoryName: null,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const countries = [
  {
    id: 1,
    code: 'MY',
    name: 'Malaysia',
    timezone: 'UTC',
    currencyCode: 'MYR',
    dialingCode: '+60',
    isHq: false,
    status: 'active' as const,
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 2,
    code: 'SG',
    name: 'Singapore',
    timezone: 'UTC',
    currencyCode: 'SGD',
    dialingCode: '+65',
    isHq: false,
    status: 'active' as const,
    createdAt: '',
    updatedAt: '',
  },
];

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AssignCountriesModal open onClose={onClose} reward={reward} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockAssignMutateAsync.mockReset();
  mockUnassignMutateAsync.mockReset();
  mockUseAssignRewardCountryMutation.mockReturnValue({ mutateAsync: mockAssignMutateAsync });
  mockUseUnassignRewardCountryMutation.mockReturnValue({ mutateAsync: mockUnassignMutateAsync });
  mockUseCountriesQuery.mockReturnValue({
    data: { data: countries, meta: { page: 1, pageSize: 100, total: 2 } },
    isLoading: false,
  });
  mockUseRewardCountriesQuery.mockReturnValue({
    data: [
      {
        id: 500,
        rewardId: 1,
        countryId: 1,
        countryCode: 'MY',
        countryName: 'Malaysia',
        assignedAt: '2026-01-01T00:00:00.000Z',
        assignedBy: null,
      },
    ],
    isLoading: false,
  });
});

describe('AssignCountriesModal', () => {
  it('T-133: the reward fixture is a shape the server can actually return', () => {
    // Vitest strips the `: Reward` annotation at transform time, so a fixture that no longer
    // matches the shared schema still runs green here and only fails `npm run typecheck`.
    // Re-judging it with zod puts the drift in front of the test suite as well.
    expect(rewardSchema.parse(reward)).toEqual(reward);
  });

  it('pre-selects the currently-assigned countries', () => {
    renderModal();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('shows a loading skeleton while countries/assignments are still loading', () => {
    mockUseCountriesQuery.mockReturnValue({ data: undefined, isLoading: true });
    renderModal();
    expect(screen.queryByRole('button', { name: /countries/i })).not.toBeInTheDocument();
  });

  it('shows a row-level error when assigning a new country fails', async () => {
    mockAssignMutateAsync.mockRejectedValue(
      new ApiError({ code: 'UNKNOWN_ERROR', message: 'Something broke.', status: 500 }),
    );
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('button', { name: /countries/i }));
    await user.click(screen.getByRole('option', { name: /Singapore \(SG\)/ }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Something broke.');
  });

  it('TC-7: assigns a newly-selected country and shows it in the diff preview', async () => {
    mockAssignMutateAsync.mockResolvedValue({});
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('button', { name: /countries/i }));
    await user.click(screen.getByRole('option', { name: /Singapore \(SG\)/ }));

    expect(screen.getByText(/\+ Singapore \(SG\)/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /save changes/i }));
    expect(mockAssignMutateAsync).toHaveBeenCalledWith({ countryId: 2 });
  });

  it('TC-9: shows a row-level error when unassigning fails (bound to an active campaign)', async () => {
    mockUnassignMutateAsync.mockRejectedValue(
      new ApiError({
        code: 'REWARD_IN_USE_BY_CAMPAIGN',
        message: 'In use by a campaign.',
        status: 422,
      }),
    );
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('button', { name: /countries/i }));
    await user.click(screen.getByRole('option', { name: /Malaysia \(MY\)/ }));

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('In use by a campaign.');
  });
});
