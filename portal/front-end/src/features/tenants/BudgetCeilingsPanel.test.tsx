import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';

const { mockUseBudgetCeilingsQuery, mockUseUpsertBudgetCeilingMutation, mockMutateAsync } =
  vi.hoisted(() => ({
    mockUseBudgetCeilingsQuery: vi.fn(),
    mockUseUpsertBudgetCeilingMutation: vi.fn(),
    mockMutateAsync: vi.fn(),
  }));

vi.mock('./api', () => ({
  useBudgetCeilingsQuery: mockUseBudgetCeilingsQuery,
  useUpsertBudgetCeilingMutation: mockUseUpsertBudgetCeilingMutation,
}));

import { BudgetCeilingsPanel } from './BudgetCeilingsPanel';

const ceiling = {
  id: 1,
  tenantId: 10,
  unitType: 'currency' as const,
  unitCode: 'MYR',
  maxCampaignBudget: '5000000.0000',
  warnAboveAmount: '4000000.0000',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function bootstrapValue(canEdit: boolean): BootstrapContextValue {
  return {
    user: {
      id: 1,
      displayName: 'Test User',
      role: canEdit ? 'country_admin' : 'tenant_admin',
      locale: 'en',
      timezone: null,
    },
    scope: { countryId: canEdit ? 1 : null, tenantId: canEdit ? null : 10, merchantId: null },
    nav: [],
    permissions: {},
    widgets: [],
    messages: {},
    isLoading: false,
    isError: false,
    isUnauthorized: false,
    hasPermission: (entity, action) =>
      entity === 'tenant_budget_ceiling' && action === 'update' ? canEdit : true,
    refetch: () => undefined,
  };
}

function renderPanel(canEdit: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(canEdit)}>
        <BudgetCeilingsPanel tenantId={10} />
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUseBudgetCeilingsQuery.mockReset();
  mockUseUpsertBudgetCeilingMutation.mockReset();
  mockMutateAsync.mockReset();
  mockUseUpsertBudgetCeilingMutation.mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  });
});

describe('BudgetCeilingsPanel', () => {
  it('renders existing ceilings (TC-21/TC-22)', () => {
    mockUseBudgetCeilingsQuery.mockReturnValue({
      data: [ceiling],
      isLoading: false,
      isError: false,
    });

    renderPanel(true);

    expect(screen.getByText('MYR')).toBeInTheDocument();
    expect(screen.getByText('5000000.0000')).toBeInTheDocument();
    expect(screen.getByText('4000000.0000')).toBeInTheDocument();
  });

  it('shows the unlimited empty state when no ceiling is configured', () => {
    mockUseBudgetCeilingsQuery.mockReturnValue({ data: [], isLoading: false, isError: false });

    renderPanel(true);

    expect(screen.getByText(/unlimited/i)).toBeInTheDocument();
  });

  it('shows the edit form only for a caller holding tenant_budget_ceiling:update (TC-23/TC-24)', () => {
    mockUseBudgetCeilingsQuery.mockReturnValue({ data: [], isLoading: false, isError: false });

    renderPanel(false);

    expect(screen.queryByRole('button', { name: /save ceiling/i })).not.toBeInTheDocument();
  });

  it('submits a new ceiling (TC-21)', async () => {
    mockUseBudgetCeilingsQuery.mockReturnValue({ data: [], isLoading: false, isError: false });
    mockMutateAsync.mockResolvedValue([ceiling]);
    const user = userEvent.setup();

    renderPanel(true);

    await user.type(screen.getByLabelText(/unit code/i), 'MYR');
    await user.type(screen.getByLabelText(/max campaign budget/i), '5000000');
    await user.type(screen.getByLabelText(/warn above/i), '4000000');
    await user.click(screen.getByRole('button', { name: /save ceiling/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith({
      unitType: 'currency',
      unitCode: 'MYR',
      maxCampaignBudget: '5000000',
      warnAboveAmount: '4000000',
    });
  });

  it('shows the server-side rejection when warnAboveAmount exceeds the ceiling (TC-27)', async () => {
    mockUseBudgetCeilingsQuery.mockReturnValue({ data: [], isLoading: false, isError: false });
    mockMutateAsync.mockRejectedValue(
      Object.assign(new Error('warnAboveAmount must not exceed maxCampaignBudget'), {
        code: 'VALIDATION_FAILED',
      }),
    );
    const user = userEvent.setup();

    renderPanel(true);

    await user.type(screen.getByLabelText(/unit code/i), 'MYR');
    await user.type(screen.getByLabelText(/max campaign budget/i), '5000000');
    await user.type(screen.getByLabelText(/warn above/i), '6000000');
    await user.click(screen.getByRole('button', { name: /save ceiling/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
