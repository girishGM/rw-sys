import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';

const {
  mockUseTenantQuery,
  mockUseActivateTenantMutation,
  mockUseUpdateTenantMutation,
  mockActivate,
  mockUpdate,
} = vi.hoisted(() => ({
  mockUseTenantQuery: vi.fn(),
  mockUseActivateTenantMutation: vi.fn(),
  mockUseUpdateTenantMutation: vi.fn(),
  mockActivate: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock('./api', () => ({
  useTenantQuery: mockUseTenantQuery,
  useActivateTenantMutation: mockUseActivateTenantMutation,
  useUpdateTenantMutation: mockUseUpdateTenantMutation,
}));
vi.mock('./AddTenantAdminModal', () => ({
  AddTenantAdminModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-admin-modal" /> : null,
}));
// This suite covers the page's own lifecycle actions; BudgetCeilingsPanel has its own test file.
vi.mock('./BudgetCeilingsPanel', () => ({
  BudgetCeilingsPanel: () => <div data-testid="budget-ceilings-panel" />,
}));

import { TenantDetailPage } from './TenantDetailPage';

const tenant = {
  id: 10,
  code: 'T001',
  name: 'Acme Retail',
  countryId: 1,
  schemaPrefix: 'acme',
  contactEmail: 'ops@acme.example',
  contactPhone: null,
  status: 'pending_provisioning' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function bootstrapValue(): BootstrapContextValue {
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
    hasPermission: () => true,
    refetch: () => undefined,
  };
}

function renderPage(initialPath = '/tenants/10') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue()}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/tenants/:id" element={<TenantDetailPage />} />
          </Routes>
        </MemoryRouter>
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUseTenantQuery.mockReset();
  mockUseActivateTenantMutation.mockReset();
  mockUseUpdateTenantMutation.mockReset();
  mockActivate.mockReset();
  mockUpdate.mockReset();
  mockUseActivateTenantMutation.mockReturnValue({ mutate: mockActivate, isPending: false });
  mockUseUpdateTenantMutation.mockReturnValue({ mutate: mockUpdate, isPending: false });
});

describe('TenantDetailPage', () => {
  it('renders the tenant name, code and details', () => {
    mockUseTenantQuery.mockReturnValue({ data: tenant, isLoading: false, isError: false });

    renderPage();

    expect(screen.getByRole('heading', { name: 'Acme Retail' })).toBeInTheDocument();
    expect(screen.getByText('T001')).toBeInTheDocument();
    expect(screen.getByText('acme')).toBeInTheDocument();
    expect(screen.getByText('ops@acme.example')).toBeInTheDocument();
  });

  it('renders the budget ceilings panel', () => {
    mockUseTenantQuery.mockReturnValue({ data: tenant, isLoading: false, isError: false });
    renderPage();
    expect(screen.getByTestId('budget-ceilings-panel')).toBeInTheDocument();
  });

  it('offers Activate for a pending_provisioning tenant, and calls the activation mutation (TC-15)', async () => {
    mockUseTenantQuery.mockReturnValue({ data: tenant, isLoading: false, isError: false });
    const user = userEvent.setup();

    renderPage();
    expect(screen.queryByRole('button', { name: /suspend/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^activate$/i }));
    expect(mockActivate).toHaveBeenCalledTimes(1);
  });

  it('offers Suspend for an active tenant, behind an explicit confirmation (TC-18, implementation note 8)', async () => {
    mockUseTenantQuery.mockReturnValue({
      data: { ...tenant, status: 'active' },
      isLoading: false,
      isError: false,
    });
    const user = userEvent.setup();

    renderPage();
    expect(screen.queryByRole('button', { name: /^activate$/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /suspend/i }));
    // The consequence is surfaced, not applied silently — no mutation yet.
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/logged out immediately/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /suspend anyway/i }));
    expect(mockUpdate).toHaveBeenCalledWith(
      { status: 'suspended' },
      expect.objectContaining({ onSuccess: expect.any(Function) as unknown }),
    );
  });

  it('shows neither Activate nor Suspend for a suspended tenant', () => {
    mockUseTenantQuery.mockReturnValue({
      data: { ...tenant, status: 'suspended' },
      isLoading: false,
      isError: false,
    });

    renderPage();

    expect(screen.queryByRole('button', { name: /^activate$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /suspend/i })).not.toBeInTheDocument();
  });

  it('opens the Add Tenant Admin modal', async () => {
    mockUseTenantQuery.mockReturnValue({ data: tenant, isLoading: false, isError: false });
    const user = userEvent.setup();

    renderPage();
    await user.click(screen.getByRole('button', { name: /add tenant admin/i }));

    expect(screen.getByTestId('add-admin-modal')).toBeInTheDocument();
  });

  it('shows loading skeletons while the tenant is loading', () => {
    mockUseTenantQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false });

    renderPage();

    expect(screen.queryByRole('heading', { name: 'Acme Retail' })).not.toBeInTheDocument();
  });

  it('shows an error state when the tenant cannot be loaded', () => {
    mockUseTenantQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: null,
    });

    renderPage();

    expect(screen.getByText('Could not load this tenant', { exact: true })).toBeInTheDocument();
  });

  it('shows the server error message when it is an ApiError instance', async () => {
    const { ApiError } = await import('../../lib/apiError');
    mockUseTenantQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError({ code: 'NOT_FOUND', message: 'No such tenant.', status: 404 }),
    });

    renderPage();

    expect(screen.getByText('No such tenant.')).toBeInTheDocument();
  });

  it('shows an invalid-id message for a non-numeric route param', () => {
    mockUseTenantQuery.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    renderPage('/tenants/not-a-number');
    expect(screen.getByText('Invalid tenant id')).toBeInTheDocument();
  });
});
