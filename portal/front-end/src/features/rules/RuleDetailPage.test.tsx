import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';

const { mockUseRuleQuery, mockUseRuleCountriesQuery, mockUseDeleteRuleMutation } = vi.hoisted(
  () => ({
    mockUseRuleQuery: vi.fn(),
    mockUseRuleCountriesQuery: vi.fn(),
    mockUseDeleteRuleMutation: vi.fn(),
  }),
);

vi.mock('./api', () => ({
  useRuleQuery: mockUseRuleQuery,
  useRuleCountriesQuery: mockUseRuleCountriesQuery,
  useDeleteRuleMutation: mockUseDeleteRuleMutation,
}));
vi.mock('./EditRuleModal', () => ({
  EditRuleModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="edit-rule-modal" /> : null,
}));
vi.mock('./AssignCountriesModal', () => ({
  AssignCountriesModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="assign-countries-modal" /> : null,
}));

import { RuleDetailPage } from './RuleDetailPage';

const rule = {
  id: 1,
  ruleCode: 'MIN_SPEND_TIER',
  name: 'Minimum spend tier',
  categoryId: 13,
  categoryName: 'TRANSACTION',
  subCategoryId: 13,
  subCategoryName: 'General',
  expression: 'amount >= :minSpend',
  parameters: {
    fields: [{ key: 'minSpend', label: 'Minimum spend', type: 'number' as const, required: true }],
  },
  status: 'active' as const,
  createdBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function bootstrapValue(overrides: Partial<Record<string, boolean>> = {}): BootstrapContextValue {
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
    hasPermission: (entity, action) => overrides[`${entity}:${action}`] ?? false,
    refetch: () => undefined,
  };
}

function renderPage(permissions: Record<string, boolean> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(permissions)}>
        <MemoryRouter initialEntries={['/rules/1']}>
          <Routes>
            <Route path="/rules/:id" element={<RuleDetailPage />} />
          </Routes>
        </MemoryRouter>
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUseRuleQuery.mockReset();
  mockUseRuleCountriesQuery.mockReset();
  mockUseDeleteRuleMutation.mockReset();
  mockUseDeleteRuleMutation.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  mockUseRuleCountriesQuery.mockReturnValue({ data: [], isLoading: false });
});

describe('RuleDetailPage', () => {
  it('renders the rule name, code and expression', () => {
    mockUseRuleQuery.mockReturnValue({ data: rule, isLoading: false, isError: false });

    renderPage({ 'rule:view': true });

    expect(screen.getByText('Minimum spend tier')).toBeInTheDocument();
    expect(screen.getByText(/MIN_SPEND_TIER/)).toBeInTheDocument();
    expect(screen.getByText('amount >= :minSpend')).toBeInTheDocument();
  });

  it('TC-24: super_admin (full CRUD) sees Edit, Delete and Assign countries', () => {
    mockUseRuleQuery.mockReturnValue({ data: rule, isLoading: false, isError: false });

    renderPage({ 'rule:update': true, 'rule:delete': true, 'rule_assignment:create': true });

    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /assign countries/i })).toBeInTheDocument();
  });

  it('TC-23: maker (read-only) sees no Edit, Delete or Assign control', () => {
    mockUseRuleQuery.mockReturnValue({ data: rule, isLoading: false, isError: false });

    renderPage({});

    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /assign countries/i })).not.toBeInTheDocument();
    // Still read-only-visible: the rule content itself renders.
    expect(screen.getByText('Minimum spend tier')).toBeInTheDocument();
  });

  it('shows a 404/error state when the rule is not visible to the caller (TC-8)', () => {
    mockUseRuleQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { message: 'Not found.' },
    });

    renderPage({});
    expect(screen.getByText('Could not load this rule')).toBeInTheDocument();
  });
});
