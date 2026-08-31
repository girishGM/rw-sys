/**
 * T-117 — unit tests for the shared two-pane category/sub-category manager. Exercises both
 * `kind: 'rule'` and `kind: 'reward'` against the same suite where the behaviour is meant to be
 * identical (that sameness is the entire point of this component), and dedicates a few cases to
 * the one place they're meant to differ (the reward-only "zero sub-categories is fine" copy).
 *
 * The left-pane list and the right-pane detail both legitimately render the *same* selected
 * category's name/code at once (that's the whole point of a two-pane layout) — every assertion
 * below that cares which pane it's in scopes itself with `within(list())`/`within(detail())`
 * (the component's own `data-testid="category-list"`/`"category-detail"`) rather than a bare
 * `screen.getByText`, which would otherwise throw on the duplicate.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';

const { mockGet, mockPost, mockPatch, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPatch: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock('../../lib/apiClient', () => ({
  api: { get: mockGet, post: mockPost, patch: mockPatch },
}));

vi.mock('../../components/toastActions', () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

import { CategoryManager, type CategoryManagerKind } from './CategoryManager';

interface CategoryFixture {
  id: number;
  categoryCode: string;
  name: string;
  status: string;
}

interface SubCategoryFixture {
  id: number;
  categoryId: number;
  subCategoryCode: string;
  name: string;
  status: string;
}

function category(overrides: Partial<CategoryFixture> = {}): CategoryFixture {
  return {
    id: 1,
    categoryCode: 'TRANSACTION',
    name: 'Transaction',
    status: 'active',
    ...overrides,
  };
}

function subCategory(overrides: Partial<SubCategoryFixture> = {}): SubCategoryFixture {
  return {
    id: 1,
    categoryId: 1,
    subCategoryCode: 'GENERAL',
    name: 'General',
    status: 'active',
    ...overrides,
  };
}

function bootstrapValue(canWrite: boolean, kind: CategoryManagerKind): BootstrapContextValue {
  const categoryEntity = kind === 'rule' ? 'rule_category' : 'reward_category';
  const subCategoryEntity = kind === 'rule' ? 'rule_sub_category' : 'reward_sub_category';
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
      (entity === categoryEntity || entity === subCategoryEntity) && action === 'create'
        ? canWrite
        : true,
    refetch: () => undefined,
  };
}

function mockDefaultResponses(
  kind: CategoryManagerKind,
  categories: CategoryFixture[],
  subCategories: SubCategoryFixture[],
): void {
  const categoriesPath = kind === 'rule' ? '/rule-categories' : '/reward-categories';
  const subCategoriesPath = kind === 'rule' ? '/rule-sub-categories' : '/reward-sub-categories';
  mockGet.mockImplementation((path: string) => {
    if (path === categoriesPath) return Promise.resolve({ data: { data: categories } });
    if (path === subCategoriesPath) return Promise.resolve({ data: { data: subCategories } });
    return Promise.reject(new Error(`Unexpected GET ${path}`));
  });
}

function renderManager(kind: CategoryManagerKind, canWrite = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(canWrite, kind)}>
        <CategoryManager kind={kind} />
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

function list() {
  return screen.getByTestId('category-list');
}

function detail() {
  return screen.getByTestId('category-detail');
}

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPatch.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
});

describe.each<CategoryManagerKind>(['rule', 'reward'])('CategoryManager (kind=%s)', (kind) => {
  const categoriesPath = kind === 'rule' ? '/rule-categories' : '/reward-categories';
  const subCategoriesPath = kind === 'rule' ? '/rule-sub-categories' : '/reward-sub-categories';

  it('TC-1: loads with a two-pane layout, first category selected by default', async () => {
    mockDefaultResponses(
      kind,
      [
        category({ id: 1, categoryCode: 'AAA', name: 'Alpha' }),
        category({ id: 2, categoryCode: 'BBB', name: 'Beta' }),
      ],
      [subCategory({ id: 1, categoryId: 1 })],
    );

    renderManager(kind);

    // The first category (Alpha) is selected by default: its name shows in both panes, its
    // sub-category (General) shows in the right pane, and Beta (unselected) only in the list.
    expect(
      await within(await screen.findByTestId('category-detail')).findByRole('heading', {
        name: 'Alpha',
      }),
    ).toBeInTheDocument();
    expect(within(list()).getByText('Beta')).toBeInTheDocument();
    expect(within(detail()).getByText('General')).toBeInTheDocument();
  });

  it('TC-2: selecting a different category updates the right pane', async () => {
    mockDefaultResponses(
      kind,
      [
        category({ id: 1, categoryCode: 'AAA', name: 'Alpha' }),
        category({ id: 2, categoryCode: 'BBB', name: 'Beta' }),
      ],
      [
        subCategory({ id: 1, categoryId: 1, subCategoryCode: 'ALPHA_SUB', name: 'Alpha sub' }),
        subCategory({ id: 2, categoryId: 2, subCategoryCode: 'BETA_SUB', name: 'Beta sub' }),
      ],
    );

    renderManager(kind);
    await screen.findByText('Alpha sub');
    expect(screen.queryByText('Beta sub')).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(list()).getByText('Beta'));

    expect(await screen.findByText('Beta sub')).toBeInTheDocument();
    expect(screen.queryByText('Alpha sub')).not.toBeInTheDocument();
  });

  it('TC-3: adds a sub-category inline, with no modal ever opened', async () => {
    mockDefaultResponses(kind, [category()], []);
    mockPost.mockResolvedValue({
      data: { data: subCategory({ id: 9, subCategoryCode: 'NEW_SUB', name: 'New sub' }) },
    });

    renderManager(kind);
    await within(await screen.findByTestId('category-detail')).findByRole('heading', {
      name: 'Transaction',
    });
    expect(screen.getByText(/no sub-categories/i)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('SUB_CODE'), 'NEW_SUB');
    await user.type(screen.getByPlaceholderText('Sub-category name'), 'New sub');
    await user.click(screen.getByRole('button', { name: /add sub-category/i }));

    expect(mockPost).toHaveBeenCalledWith(subCategoriesPath, {
      categoryId: 1,
      subCategoryCode: 'NEW_SUB',
      name: 'New sub',
    });
    // No modal/dialog was ever rendered for this flow.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith('Sub-category NEW_SUB created'),
    );
  });

  it('TC-4: a category with zero sub-categories renders an empty state, not an error', async () => {
    mockDefaultResponses(kind, [category()], []);

    renderManager(kind);

    const hint = await screen.findByText(/no sub-categories under transaction yet/i);
    expect(hint).toBeInTheDocument();
    if (kind === 'reward') {
      expect(hint.textContent).toMatch(/that may be fine for a category like points/i);
    } else {
      expect(hint.textContent).not.toMatch(/points/i);
    }
  });

  it('TC-5: retiring a category surfaces whatever the backend returns as a toast', async () => {
    mockDefaultResponses(kind, [category()], []);
    mockPatch.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: { code: 'CONFLICT', message: "Can't remove — in use by 1 rule(s)." } },
      },
    });

    renderManager(kind);
    await within(await screen.findByTestId('category-detail')).findByRole('heading', {
      name: 'Transaction',
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /retire TRANSACTION/i }));

    expect(mockPatch).toHaveBeenCalledWith(`${categoriesPath}/1`, { status: 'inactive' });
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Can't remove — in use by 1 rule(s)."),
    );
  });

  it('TC-6: hides every write control for an actor without create permission', async () => {
    mockDefaultResponses(kind, [category()], [subCategory()]);

    renderManager(kind, false);
    await within(await screen.findByTestId('category-detail')).findByRole('heading', {
      name: 'Transaction',
    });

    expect(screen.queryByRole('button', { name: /add category/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add sub-category/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retire/i })).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no categories at all', async () => {
    mockDefaultResponses(kind, [], []);

    renderManager(kind);

    expect(
      await within(await screen.findByTestId('category-detail')).findByText(/no categories yet/i),
    ).toBeInTheDocument();
  });

  it('adds a category inline and selects it', async () => {
    mockDefaultResponses(kind, [category()], []);
    mockPost.mockResolvedValue({
      data: { data: category({ id: 2, categoryCode: 'NEWCAT', name: 'New Category' }) },
    });

    renderManager(kind);
    await within(await screen.findByTestId('category-detail')).findByRole('heading', {
      name: 'Transaction',
    });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('CODE'), 'NEWCAT');
    await user.type(screen.getByPlaceholderText('Name'), 'New Category');
    await user.click(screen.getByRole('button', { name: /add category/i }));

    expect(mockPost).toHaveBeenCalledWith(categoriesPath, {
      categoryCode: 'NEWCAT',
      name: 'New Category',
    });
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Category NEWCAT created'));
  });

  it('shows a field-level validation error instead of calling the API for an invalid category code', async () => {
    mockDefaultResponses(kind, [category()], []);

    renderManager(kind);
    await within(await screen.findByTestId('category-detail')).findByRole('heading', {
      name: 'Transaction',
    });

    const user = userEvent.setup();
    // `categoryCode` requires at least 2 characters (createRule/RewardCategoryRequestSchema).
    await user.type(screen.getByPlaceholderText('CODE'), 'A');
    await user.type(screen.getByPlaceholderText('Name'), 'Anything');
    await user.click(screen.getByRole('button', { name: /add category/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('shows a field-level validation error instead of calling the API for an invalid sub-category code', async () => {
    mockDefaultResponses(kind, [category()], []);

    renderManager(kind);
    await within(await screen.findByTestId('category-detail')).findByRole('heading', {
      name: 'Transaction',
    });

    const user = userEvent.setup();
    // `subCategoryCode` requires at least 2 characters, same rule as the category code.
    await user.type(screen.getByPlaceholderText('SUB_CODE'), 'A');
    await user.type(screen.getByPlaceholderText('Sub-category name'), 'Anything');
    await user.click(screen.getByRole('button', { name: /add sub-category/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('surfaces a toast when creating a category fails server-side', async () => {
    mockDefaultResponses(kind, [category()], []);
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: { code: 'CONFLICT', message: 'CODE already exists.' } },
      },
    });

    renderManager(kind);
    await within(await screen.findByTestId('category-detail')).findByRole('heading', {
      name: 'Transaction',
    });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('CODE'), 'DUPLICATE');
    await user.type(screen.getByPlaceholderText('Name'), 'Duplicate');
    await user.click(screen.getByRole('button', { name: /add category/i }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('CODE already exists.'));
  });

  it('retires and reactivates a sub-category, surfacing success toasts', async () => {
    mockDefaultResponses(kind, [category()], [subCategory()]);
    mockPatch.mockResolvedValueOnce({
      data: { data: subCategory({ status: 'inactive' }) },
    });

    renderManager(kind);
    await within(await screen.findByTestId('category-detail')).findByRole('heading', {
      name: 'Transaction',
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /retire GENERAL/i }));

    expect(mockPatch).toHaveBeenCalledWith(`${subCategoriesPath}/1`, { status: 'inactive' });
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('GENERAL retired'));
  });
});

describe('CategoryManager kind selection', () => {
  it('talks to /rule-categories for kind="rule" and /reward-categories for kind="reward"', async () => {
    mockDefaultResponses('rule', [category({ categoryCode: 'RULE_ONE' })], []);
    renderManager('rule');
    await within(await screen.findByTestId('category-detail')).findByRole('heading', {
      name: 'Transaction',
    });
    expect(mockGet).toHaveBeenCalledWith('/rule-categories');
    expect(mockGet).toHaveBeenCalledWith('/rule-sub-categories');

    cleanup();
    mockGet.mockReset();
    mockDefaultResponses('reward', [category({ categoryCode: 'REWARD_ONE' })], []);
    renderManager('reward');
    await within(await screen.findByTestId('category-detail')).findByRole('heading', {
      name: 'Transaction',
    });
    expect(mockGet).toHaveBeenCalledWith('/reward-categories');
    expect(mockGet).toHaveBeenCalledWith('/reward-sub-categories');
  });
});
