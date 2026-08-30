/**
 * T-146 — unit tests for the Value Sources page: both registries render from their existing
 * queries (T-121), and the page shows the loading/empty states `Table` already handles.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { FieldApiLookupProvider, FieldContextProvider } from '@reward-portal/shared';

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

describe('ValueSourcesPage', () => {
  it('renders the page header and both registry tables with their live data', () => {
    setQueries();
    render(<ValueSourcesPage />);

    expect(screen.getByRole('heading', { name: 'Value Sources' })).toBeInTheDocument();
    expect(screen.getByText('Context Providers')).toBeInTheDocument();
    expect(screen.getByText('API Lookup Providers')).toBeInTheDocument();
    expect(screen.getByText('SIBLING_COMPONENTS')).toBeInTheDocument();
    expect(screen.getByText('PRODUCT_CATALOG')).toBeInTheDocument();
    expect(screen.getByText('GET /api/lookups/products')).toBeInTheDocument();
  });

  it("shows each table's own empty state when its registry has no rows", () => {
    setQueries({ context: { data: [] }, apiLookup: { data: [] } });
    render(<ValueSourcesPage />);

    expect(screen.getByText('No context providers registered')).toBeInTheDocument();
    expect(screen.getByText('No API lookup providers registered')).toBeInTheDocument();
  });
});
