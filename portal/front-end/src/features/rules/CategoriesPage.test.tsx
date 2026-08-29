/**
 * T-107 — unit tests for the Categories page. Follows `RulesListPage.test.tsx`'s exact harness:
 * `./api` hooks mocked, modals stubbed (this suite exercises the list/permission-gating, not the
 * create/edit forms — those are `AddCategoryModal`/`EditCategoryModal`'s own concern).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RuleCategory, RuleSubCategory } from '@reward-portal/shared';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';

const { mockUseRuleCategoriesQuery, mockUseRuleSubCategoriesQuery } = vi.hoisted(() => ({
  mockUseRuleCategoriesQuery: vi.fn(),
  mockUseRuleSubCategoriesQuery: vi.fn(),
}));

vi.mock('./api', () => ({
  useRuleCategoriesQuery: mockUseRuleCategoriesQuery,
  useRuleSubCategoriesQuery: mockUseRuleSubCategoriesQuery,
}));

vi.mock('./AddCategoryModal', () => ({
  AddCategoryModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-category-modal" /> : null,
}));
vi.mock('./EditCategoryModal', () => ({
  EditCategoryModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="edit-category-modal" /> : null,
}));
vi.mock('./AddSubCategoryModal', () => ({
  AddSubCategoryModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-sub-category-modal" /> : null,
}));
vi.mock('./EditSubCategoryModal', () => ({
  EditSubCategoryModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="edit-sub-category-modal" /> : null,
}));

import { CategoriesPage } from './CategoriesPage';

function category(overrides: Partial<RuleCategory> = {}): RuleCategory {
  return {
    id: 1,
    categoryCode: 'TRANSACTION',
    name: 'TRANSACTION',
    status: 'active',
    ...overrides,
  };
}

function subCategory(overrides: Partial<RuleSubCategory> = {}): RuleSubCategory {
  return {
    id: 1,
    categoryId: 1,
    subCategoryCode: 'GENERAL',
    name: 'General',
    status: 'active',
    ...overrides,
  };
}

function bootstrapValue(canWrite: boolean): BootstrapContextValue {
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
      entity === 'rule_category' && action === 'create' ? canWrite : true,
    refetch: () => undefined,
  };
}

function renderPage(canWrite: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(canWrite)}>
        <CategoriesPage />
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

describe('CategoriesPage', () => {
  it('renders every category with its sub-categories nested underneath', () => {
    mockUseRuleCategoriesQuery.mockReturnValue({
      data: [
        category({ id: 1, categoryCode: 'COMPONENT', name: 'Cross-Component Dependency Rules' }),
      ],
      isLoading: false,
    });
    mockUseRuleSubCategoriesQuery.mockReturnValue({
      data: [
        subCategory({
          id: 1,
          categoryId: 1,
          subCategoryCode: 'COMP_STATUS_CHECK',
          name: 'Sibling Component Status',
        }),
      ],
      isLoading: false,
    });

    renderPage(true);

    expect(screen.getByText('COMPONENT')).toBeInTheDocument();
    expect(screen.getByText('Cross-Component Dependency Rules')).toBeInTheDocument();
    expect(screen.getByText('COMP_STATUS_CHECK')).toBeInTheDocument();
    expect(screen.getByText('Sibling Component Status')).toBeInTheDocument();
  });

  it('shows "Add category" / "Edit" / "+ Sub-category" only when the actor can write', () => {
    mockUseRuleCategoriesQuery.mockReturnValue({ data: [category()], isLoading: false });
    mockUseRuleSubCategoriesQuery.mockReturnValue({ data: [subCategory()], isLoading: false });

    renderPage(false);
    expect(screen.queryByRole('button', { name: /add category/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('renders "Add category" for a writer and opens the modal on click', async () => {
    mockUseRuleCategoriesQuery.mockReturnValue({ data: [category()], isLoading: false });
    mockUseRuleSubCategoriesQuery.mockReturnValue({ data: [], isLoading: false });

    renderPage(true);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /add category/i }));
    expect(screen.getByTestId('add-category-modal')).toBeInTheDocument();
  });

  it('shows an empty state when there are no categories', () => {
    mockUseRuleCategoriesQuery.mockReturnValue({ data: [], isLoading: false });
    mockUseRuleSubCategoriesQuery.mockReturnValue({ data: [], isLoading: false });

    renderPage(true);
    expect(screen.getByText(/no categories yet/i)).toBeInTheDocument();
  });
});
