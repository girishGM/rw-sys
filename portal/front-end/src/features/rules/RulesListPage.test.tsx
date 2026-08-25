import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Rule } from '@reward-portal/shared';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';

const { mockUseRulesQuery } = vi.hoisted(() => ({ mockUseRulesQuery: vi.fn() }));

vi.mock('./api', () => ({ useRulesQuery: mockUseRulesQuery }));
// AddRuleModal pulls in the real mutation/category hooks; stubbed here since this suite only
// exercises the list screen, not the create flow.
vi.mock('./AddRuleModal', () => ({
  AddRuleModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-rule-modal" /> : null,
}));

import { RulesListPage } from './RulesListPage';

function ruleRow(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 1,
    ruleCode: 'MIN_SPEND_TIER',
    name: 'Minimum spend tier',
    categoryId: 13,
    categoryName: 'TRANSACTION',
    subCategoryId: 13,
    subCategoryName: 'General',
    expression: 'amount >= :minSpend',
    parameters: { fields: [] },
    status: 'active',
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const rules: Rule[] = [
  ruleRow({ id: 1, ruleCode: 'MIN_SPEND_TIER', name: 'Minimum spend tier' }),
  ruleRow({ id: 2, ruleCode: 'WEEKEND_BOOST', name: 'Weekend boost', status: 'inactive' }),
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
      entity === 'rule' && action === 'create' ? canCreate : true,
    refetch: () => undefined,
  };
}

function renderPage(canCreate: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(canCreate)}>
        <MemoryRouter initialEntries={['/rules']}>
          <Routes>
            <Route path="/rules" element={<RulesListPage />} />
            <Route path="/rules/:id" element={<div>Rule detail screen</div>} />
          </Routes>
        </MemoryRouter>
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUseRulesQuery.mockReset();
});

describe('RulesListPage', () => {
  it('renders every rule row', () => {
    mockUseRulesQuery.mockReturnValue({
      data: { data: rules, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });

    renderPage(true);

    expect(screen.getByText('Minimum spend tier')).toBeInTheDocument();
    expect(screen.getByText('Weekend boost')).toBeInTheDocument();
  });

  it('TC-24: shows "Add rule" for a caller holding rule:create (super_admin)', () => {
    mockUseRulesQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });

    renderPage(true);
    expect(screen.getByRole('button', { name: /add rule/i })).toBeInTheDocument();
  });

  it('TC-23: hides "Add rule" for a caller without rule:create (e.g. maker) — read-only', () => {
    mockUseRulesQuery.mockReturnValue({
      data: { data: rules, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });

    renderPage(false);
    expect(screen.queryByRole('button', { name: /add rule/i })).not.toBeInTheDocument();
    // Read-only: the rows themselves still render, just no create control.
    expect(screen.getByText('Minimum spend tier')).toBeInTheDocument();
  });

  it('opens the Add Rule modal when the button is clicked', async () => {
    mockUseRulesQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByRole('button', { name: /add rule/i }));

    expect(screen.getByTestId('add-rule-modal')).toBeInTheDocument();
  });

  it('navigates to the rule detail screen when a row is clicked', async () => {
    mockUseRulesQuery.mockReturnValue({
      data: { data: rules, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByText('Minimum spend tier'));

    await waitFor(() => {
      expect(screen.getByText('Rule detail screen')).toBeInTheDocument();
    });
  });

  it('renders an empty state when there are no rules', () => {
    mockUseRulesQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });

    renderPage(true);
    expect(screen.getByText('No rules yet')).toBeInTheDocument();
  });

  it('shows the loading state', () => {
    mockUseRulesQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderPage(true);
    expect(screen.getByRole('status', { name: /loading table data/i })).toBeInTheDocument();
  });

  it('shows the server error message when the list fails to load', () => {
    mockUseRulesQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new ApiError({ code: 'PERM_DENIED', message: 'You may not view this.', status: 403 }),
    });
    renderPage(true);
    expect(screen.getByRole('alert')).toHaveTextContent('You may not view this.');
  });

  it('re-requests the next page', async () => {
    mockUseRulesQuery.mockReturnValue({
      data: { data: rules, meta: { page: 1, pageSize: 1, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByRole('button', { name: /^next$/i }));

    const lastCall = mockUseRulesQuery.mock.calls.at(-1)?.[0] as { page: number };
    expect(lastCall.page).toBe(2);
  });

  it('toggles sort direction on repeated header clicks, resetting back to page 1', async () => {
    mockUseRulesQuery.mockReturnValue({
      data: { data: rules, meta: { page: 1, pageSize: 1, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);

    const sortButton = screen.getByRole('columnheader', { name: /code/i }).querySelector('button')!;
    await user.click(sortButton);
    await user.click(sortButton);

    const lastCall = mockUseRulesQuery.mock.calls.at(-1)?.[0] as { page: number; sort: string };
    expect(lastCall.sort).toBe('ruleCode:desc');
    expect(lastCall.page).toBe(1);
  });
});
