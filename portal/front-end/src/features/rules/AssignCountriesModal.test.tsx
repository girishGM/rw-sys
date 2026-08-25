import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Rule } from '@reward-portal/shared';
import { ApiError } from '../../lib/apiError';

const {
  mockUseCountriesQuery,
  mockUseRuleCountriesQuery,
  mockAssignMutateAsync,
  mockUseAssignRuleCountryMutation,
  mockUnassignMutateAsync,
  mockUseUnassignRuleCountryMutation,
} = vi.hoisted(() => ({
  mockUseCountriesQuery: vi.fn(),
  mockUseRuleCountriesQuery: vi.fn(),
  mockAssignMutateAsync: vi.fn(),
  mockUseAssignRuleCountryMutation: vi.fn(),
  mockUnassignMutateAsync: vi.fn(),
  mockUseUnassignRuleCountryMutation: vi.fn(),
}));

vi.mock('../countries/api', () => ({ useCountriesQuery: mockUseCountriesQuery }));
vi.mock('./api', () => ({
  useRuleCountriesQuery: mockUseRuleCountriesQuery,
  useAssignRuleCountryMutation: mockUseAssignRuleCountryMutation,
  useUnassignRuleCountryMutation: mockUseUnassignRuleCountryMutation,
}));

import { AssignCountriesModal } from './AssignCountriesModal';

const rule: Rule = {
  id: 1,
  ruleCode: 'MIN_SPEND_TIER',
  name: 'Minimum spend tier',
  categoryId: 13,
  categoryName: 'TRANSACTION',
  subCategoryId: 13,
  subCategoryName: 'General',
  expression: null,
  parameters: { fields: [] },
  status: 'active',
  createdBy: null,
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
      <AssignCountriesModal open onClose={onClose} rule={rule} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockAssignMutateAsync.mockReset();
  mockUnassignMutateAsync.mockReset();
  mockUseAssignRuleCountryMutation.mockReturnValue({ mutateAsync: mockAssignMutateAsync });
  mockUseUnassignRuleCountryMutation.mockReturnValue({ mutateAsync: mockUnassignMutateAsync });
  mockUseCountriesQuery.mockReturnValue({
    data: { data: countries, meta: { page: 1, pageSize: 100, total: 2 } },
    isLoading: false,
  });
  mockUseRuleCountriesQuery.mockReturnValue({
    data: [
      {
        id: 500,
        ruleId: 1,
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
  it('pre-selects the currently-assigned countries', () => {
    renderModal();
    // The trigger summarises the selection by count; the multi-select's own coverage of
    // rendering individual chips/labels lives in `MultiSelect.test.tsx` (T-021).
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('TC-10: assigns a newly-selected country and shows it in the diff preview', async () => {
    mockAssignMutateAsync.mockResolvedValue({});
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('button', { name: /countries/i }));
    await user.click(screen.getByRole('option', { name: /Singapore \(SG\)/ }));

    expect(screen.getByText(/\+ Singapore \(SG\)/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /save changes/i }));
    expect(mockAssignMutateAsync).toHaveBeenCalledWith({ countryId: 2 });
  });

  it('TC-12: shows a row-level error when unassigning fails (bound to an active campaign)', async () => {
    mockUnassignMutateAsync.mockRejectedValue(
      new ApiError({
        code: 'RULE_IN_USE_BY_CAMPAIGN',
        message: 'In use by a campaign.',
        status: 422,
      }),
    );
    const user = userEvent.setup();
    renderModal();

    // Deselect the already-assigned Malaysia — the multi-select shows a remove control per chip.
    await user.click(screen.getByRole('button', { name: /countries/i }));
    await user.click(screen.getByRole('option', { name: /Malaysia \(MY\)/ }));

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('In use by a campaign.');
  });
});
