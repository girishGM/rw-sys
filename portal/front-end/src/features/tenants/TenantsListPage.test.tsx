import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Tenant } from '@reward-portal/shared';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';

const { mockUseTenantsQuery } = vi.hoisted(() => ({ mockUseTenantsQuery: vi.fn() }));

vi.mock('./api', () => ({ useTenantsQuery: mockUseTenantsQuery }));
// AddTenantModal pulls in the real mutation hooks / apiClient; stubbed out here since this suite
// only exercises the list screen, not the create flow (covered by AddTenantModal.test.tsx).
vi.mock('./AddTenantModal', () => ({
  AddTenantModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-tenant-modal" /> : null,
}));

import { TenantsListPage } from './TenantsListPage';

const tenants: Tenant[] = [
  {
    id: 10,
    code: 'T001',
    name: 'Acme Retail',
    countryId: 1,
    schemaPrefix: null,
    contactEmail: null,
    contactPhone: null,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 11,
    code: 'T002',
    name: 'Globex Corp',
    countryId: 1,
    schemaPrefix: null,
    contactEmail: null,
    contactPhone: null,
    status: 'pending_provisioning',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

function bootstrapValue(canCreate: boolean): BootstrapContextValue {
  return {
    user: { id: 1, displayName: 'Test User', role: 'country_admin', locale: 'en', timezone: null },
    scope: { countryId: 1, tenantId: null, merchantId: null },
    nav: [],
    permissions: {},
    widgets: [],
    messages: {},
    isLoading: false,
    isError: false,
    isUnauthorized: false,
    hasPermission: (entity, action) =>
      entity === 'tenant' && action === 'create' ? canCreate : true,
    refetch: () => undefined,
  };
}

function renderPage(canCreate: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(canCreate)}>
        <MemoryRouter initialEntries={['/tenants']}>
          <Routes>
            <Route path="/tenants" element={<TenantsListPage />} />
            <Route path="/tenants/:id" element={<div>Tenant detail screen</div>} />
          </Routes>
        </MemoryRouter>
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUseTenantsQuery.mockReset();
});

describe('TenantsListPage', () => {
  it('renders every tenant row', () => {
    mockUseTenantsQuery.mockReturnValue({
      data: { data: tenants, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });

    renderPage(true);

    expect(screen.getByText('Acme Retail')).toBeInTheDocument();
    expect(screen.getByText('Globex Corp')).toBeInTheDocument();
  });

  it('shows "Add tenant" only when the caller holds tenant:create (TC-6, 00-ARCHITECTURE.md §7)', () => {
    mockUseTenantsQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });

    renderPage(false);
    expect(screen.queryByRole('button', { name: /add tenant/i })).not.toBeInTheDocument();
  });

  it('opens the Add Tenant modal when the button is clicked', async () => {
    mockUseTenantsQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByRole('button', { name: /add tenant/i }));

    expect(screen.getByTestId('add-tenant-modal')).toBeInTheDocument();
  });

  it('navigates to the tenant detail screen when a row is clicked', async () => {
    mockUseTenantsQuery.mockReturnValue({
      data: { data: tenants, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByText('Acme Retail'));

    await waitFor(() => {
      expect(screen.getByText('Tenant detail screen')).toBeInTheDocument();
    });
  });

  it('renders an empty state when there are no tenants', () => {
    mockUseTenantsQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });

    renderPage(true);
    expect(screen.getByText('No tenants yet')).toBeInTheDocument();
  });

  it('shows the loading state', () => {
    mockUseTenantsQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderPage(true);
    expect(screen.getByRole('status', { name: /loading table data/i })).toBeInTheDocument();
  });

  it('shows the server error message when the list fails to load', () => {
    mockUseTenantsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new ApiError({ code: 'PERM_DENIED', message: 'You may not view this.', status: 403 }),
    });
    renderPage(true);
    expect(screen.getByRole('alert')).toHaveTextContent('You may not view this.');
  });

  it('re-requests the next page', async () => {
    mockUseTenantsQuery.mockReturnValue({
      data: { data: tenants, meta: { page: 1, pageSize: 1, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByRole('button', { name: /^next$/i }));

    const lastCall = mockUseTenantsQuery.mock.calls.at(-1)?.[0] as { page: number };
    expect(lastCall.page).toBe(2);
  });

  it('toggles sort direction on repeated header clicks, resetting back to page 1', async () => {
    mockUseTenantsQuery.mockReturnValue({
      data: { data: tenants, meta: { page: 1, pageSize: 1, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);

    const sortButton = screen.getByRole('columnheader', { name: /code/i }).querySelector('button')!;
    await user.click(sortButton); // 'name:asc' -> 'code:asc' (a different column resets to asc)
    await user.click(sortButton); // 'code:asc' -> 'code:desc' (same column toggles)

    const lastCall = mockUseTenantsQuery.mock.calls.at(-1)?.[0] as {
      page: number;
      sort: string;
    };
    expect(lastCall.sort).toBe('code:desc');
    expect(lastCall.page).toBe(1);
  });

  it('renders a status badge for every ck_tenants_status value', () => {
    mockUseTenantsQuery.mockReturnValue({
      data: {
        data: [
          { ...tenants[0], status: 'active' },
          { ...tenants[1], status: 'pending_provisioning' },
        ],
        meta: { page: 1, pageSize: 20, total: 2 },
      },
      isLoading: false,
      error: null,
    });

    renderPage(true);
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('pending_provisioning')).toBeInTheDocument();
  });
});
