/**
 * T-146 — unit tests for the Value Sources page: both registries render from their existing
 * queries (T-121), and the page shows the loading/empty states `Table` already handles.
 *
 * T-162 — add/edit affordances, gated on `hasPermission('field_context_provider'/
 * 'field_api_lookup_provider', 'create'|'update')` (TC-5: hidden for a non-`super_admin`
 * caller; the real 403 is the server's `@RequirePermission` + `assertRole`, unchanged by this
 * task — see `ValueSourcesPage.tsx`'s own header). The four modals are stubbed here, the same
 * way `RulesListPage.test.tsx` stubs `AddRuleModal`, so this suite only exercises the page's own
 * wiring; each modal has its own test file.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FieldApiLookupProvider, FieldContextProvider } from '@reward-portal/shared';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';

const { mockUseFieldContextProvidersQuery, mockUseFieldApiLookupProvidersQuery } = vi.hoisted(
  () => ({
    mockUseFieldContextProvidersQuery: vi.fn(),
    mockUseFieldApiLookupProvidersQuery: vi.fn(),
  }),
);

vi.mock('./api', () => ({
  useFieldContextProvidersQuery: mockUseFieldContextProvidersQuery,
  useFieldApiLookupProvidersQuery: mockUseFieldApiLookupProvidersQuery,
}));

vi.mock('./AddContextProviderModal', () => ({
  AddContextProviderModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-context-provider-modal" /> : null,
}));
vi.mock('./EditContextProviderModal', () => ({
  EditContextProviderModal: ({
    open,
    provider,
  }: {
    open: boolean;
    provider: FieldContextProvider;
  }) =>
    open ? <div data-testid="edit-context-provider-modal">{provider.providerCode}</div> : null,
}));
vi.mock('./AddApiLookupProviderModal', () => ({
  AddApiLookupProviderModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-api-lookup-provider-modal" /> : null,
}));
vi.mock('./EditApiLookupProviderModal', () => ({
  EditApiLookupProviderModal: ({
    open,
    provider,
  }: {
    open: boolean;
    provider: FieldApiLookupProvider;
  }) =>
    open ? <div data-testid="edit-api-lookup-provider-modal">{provider.providerCode}</div> : null,
}));

import { ValueSourcesPage } from './ValueSourcesPage';

const contextProvider: FieldContextProvider = {
  id: 1,
  providerCode: 'SIBLING_COMPONENTS',
  name: 'Sibling Components in this Journey',
  description: 'Every other tracker component already defined in the campaign draft.',
  status: 'active',
};

const apiLookupProvider: FieldApiLookupProvider = {
  id: 2,
  providerCode: 'PRODUCT_CATALOG',
  name: 'Product Catalog',
  description: 'Active products for the tenant/country the campaign is being built in.',
  endpointUrl: '/api/lookups/products',
  httpMethod: 'GET',
  authType: 'none',
  responseValueKey: 'code',
  responseLabelKey: 'name',
  status: 'active',
};

function setQueries(
  overrides: {
    context?: Partial<ReturnType<typeof mockUseFieldContextProvidersQuery>>;
    apiLookup?: Partial<ReturnType<typeof mockUseFieldApiLookupProvidersQuery>>;
  } = {},
): void {
  mockUseFieldContextProvidersQuery.mockReturnValue({
    data: [contextProvider],
    isLoading: false,
    error: null,
    ...overrides.context,
  });
  mockUseFieldApiLookupProvidersQuery.mockReturnValue({
    data: [apiLookupProvider],
    isLoading: false,
    error: null,
    ...overrides.apiLookup,
  });
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
      (entity === 'field_context_provider' || entity === 'field_api_lookup_provider') &&
      (action === 'create' || action === 'update')
        ? canWrite
        : true,
    refetch: () => undefined,
  };
}

function renderPage(canWrite: boolean) {
  return render(
    <BootstrapContext.Provider value={bootstrapValue(canWrite)}>
      <ValueSourcesPage />
    </BootstrapContext.Provider>,
  );
}

describe('ValueSourcesPage', () => {
  it('renders the page header and both registry tables with their live data', () => {
    setQueries();
    renderPage(true);

    expect(screen.getByRole('heading', { name: 'Value Sources' })).toBeInTheDocument();
    expect(screen.getByText('Context Providers')).toBeInTheDocument();
    expect(screen.getByText('API Lookup Providers')).toBeInTheDocument();
    expect(screen.getByText('SIBLING_COMPONENTS')).toBeInTheDocument();
    expect(screen.getByText('PRODUCT_CATALOG')).toBeInTheDocument();
    expect(screen.getByText('GET /api/lookups/products')).toBeInTheDocument();
  });

  it("shows each table's own empty state when its registry has no rows", () => {
    setQueries({ context: { data: [] }, apiLookup: { data: [] } });
    renderPage(true);

    expect(screen.getByText('No context providers registered')).toBeInTheDocument();
    expect(screen.getByText('No API lookup providers registered')).toBeInTheDocument();
  });

  it('TC-5: shows both "Add" affordances for a super_admin (write) caller', () => {
    setQueries();
    renderPage(true);

    expect(screen.getAllByRole('button', { name: /^add$/i })).toHaveLength(2);
  });

  it('TC-5: hides both "Add" affordances, and disables row-click editing, for a caller without write access', async () => {
    setQueries();
    const user = userEvent.setup();
    renderPage(false);

    expect(screen.queryByRole('button', { name: /^add$/i })).not.toBeInTheDocument();
    // Read-only: the rows themselves still render, just no write control.
    expect(screen.getByText('SIBLING_COMPONENTS')).toBeInTheDocument();
    expect(screen.getByText('PRODUCT_CATALOG')).toBeInTheDocument();

    await user.click(screen.getByText('SIBLING_COMPONENTS'));
    expect(screen.queryByTestId('edit-context-provider-modal')).not.toBeInTheDocument();
  });

  it('TC-1: opens the Add Context Provider modal from its own "Add" button', async () => {
    setQueries();
    const user = userEvent.setup();
    renderPage(true);

    const [addContextButton] = screen.getAllByRole('button', { name: /^add$/i });
    await user.click(addContextButton);

    expect(screen.getByTestId('add-context-provider-modal')).toBeInTheDocument();
  });

  it('TC-3: opens the Add API Lookup Provider modal from its own "Add" button', async () => {
    setQueries();
    const user = userEvent.setup();
    renderPage(true);

    const [, addApiLookupButton] = screen.getAllByRole('button', { name: /^add$/i });
    await user.click(addApiLookupButton);

    expect(screen.getByTestId('add-api-lookup-provider-modal')).toBeInTheDocument();
  });

  it('TC-2: clicking a context provider row opens its Edit modal, scoped to that row', async () => {
    setQueries();
    const user = userEvent.setup();
    renderPage(true);

    await user.click(screen.getByText('SIBLING_COMPONENTS'));

    expect(screen.getByTestId('edit-context-provider-modal')).toHaveTextContent(
      'SIBLING_COMPONENTS',
    );
  });

  it('TC-3: clicking an API lookup provider row opens its Edit modal, scoped to that row', async () => {
    setQueries();
    const user = userEvent.setup();
    renderPage(true);

    await user.click(screen.getByText('PRODUCT_CATALOG'));

    expect(screen.getByTestId('edit-api-lookup-provider-modal')).toHaveTextContent(
      'PRODUCT_CATALOG',
    );
  });
});
