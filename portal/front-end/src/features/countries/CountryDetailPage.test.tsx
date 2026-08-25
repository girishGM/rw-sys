import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';

const {
  mockUseCountryQuery,
  mockUseCountrySummaryQuery,
  mockUseUpdateCountryMutation,
  mockMutate,
} = vi.hoisted(() => ({
  mockUseCountryQuery: vi.fn(),
  mockUseCountrySummaryQuery: vi.fn(),
  mockUseUpdateCountryMutation: vi.fn(),
  mockMutate: vi.fn(),
}));

vi.mock('./api', () => ({
  useCountryQuery: mockUseCountryQuery,
  useCountrySummaryQuery: mockUseCountrySummaryQuery,
  useUpdateCountryMutation: mockUseUpdateCountryMutation,
}));
vi.mock('./AddCountryAdminModal', () => ({
  AddCountryAdminModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-admin-modal" /> : null,
}));

import { CountryDetailPage } from './CountryDetailPage';

const country = {
  id: 1,
  code: 'MY',
  name: 'Malaysia',
  timezone: 'Asia/Kuala_Lumpur',
  currencyCode: 'MYR',
  dialingCode: '+60',
  isHq: false,
  status: 'active' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function bootstrapValue(): BootstrapContextValue {
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
    hasPermission: () => true,
    refetch: () => undefined,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue()}>
        <MemoryRouter initialEntries={['/countries/1']}>
          <Routes>
            <Route path="/countries/:id" element={<CountryDetailPage />} />
          </Routes>
        </MemoryRouter>
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUseCountryQuery.mockReset();
  mockUseCountrySummaryQuery.mockReset();
  mockUseUpdateCountryMutation.mockReset();
  mockMutate.mockReset();
  mockUseUpdateCountryMutation.mockReturnValue({ mutate: mockMutate, isPending: false });
});

describe('CountryDetailPage', () => {
  it('renders the country name and summary counts', () => {
    mockUseCountryQuery.mockReturnValue({ data: country, isLoading: false, isError: false });
    mockUseCountrySummaryQuery.mockReturnValue({
      data: {
        countryId: 1,
        tenantCount: 2,
        activeTenantCount: 1,
        campaignCount: 3,
        tenants: [{ id: 10, code: 'T001', name: 'A Tenant', status: 'active' }],
      },
      isLoading: false,
    });

    renderPage();

    expect(screen.getByRole('heading', { name: 'Malaysia' })).toBeInTheDocument();
    expect(screen.getByText('A Tenant')).toBeInTheDocument();
  });

  it('opens the Add Country Admin modal', async () => {
    mockUseCountryQuery.mockReturnValue({ data: country, isLoading: false, isError: false });
    mockUseCountrySummaryQuery.mockReturnValue({
      data: { countryId: 1, tenantCount: 0, activeTenantCount: 0, campaignCount: 0, tenants: [] },
      isLoading: false,
    });
    const user = userEvent.setup();

    renderPage();
    await user.click(screen.getByRole('button', { name: /add country admin/i }));

    expect(screen.getByTestId('add-admin-modal')).toBeInTheDocument();
  });

  it('shows loading skeletons while the country is loading', () => {
    mockUseCountryQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    mockUseCountrySummaryQuery.mockReturnValue({ data: undefined, isLoading: true });

    renderPage();

    expect(screen.queryByRole('heading', { name: 'Malaysia' })).not.toBeInTheDocument();
  });

  it('shows a skeleton for the summary card while it loads independently of the country', () => {
    mockUseCountryQuery.mockReturnValue({ data: country, isLoading: false, isError: false });
    mockUseCountrySummaryQuery.mockReturnValue({ data: undefined, isLoading: true });

    renderPage();

    expect(screen.getByRole('heading', { name: 'Malaysia' })).toBeInTheDocument();
  });

  it('deactivates immediately (no confirm) when there are no active tenants', async () => {
    mockUseCountryQuery.mockReturnValue({ data: country, isLoading: false, isError: false });
    mockUseCountrySummaryQuery.mockReturnValue({
      data: { countryId: 1, tenantCount: 0, activeTenantCount: 0, campaignCount: 0, tenants: [] },
      isLoading: false,
    });
    const user = userEvent.setup();

    renderPage();
    await user.click(screen.getByRole('button', { name: /^deactivate$/i }));

    expect(mockMutate).toHaveBeenCalledWith({ status: 'inactive' });
    // No confirmation dialog for the zero-active-tenant path.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('requires an explicit confirmation to deactivate a country with active tenants (TC-14, implementation note 7)', async () => {
    mockUseCountryQuery.mockReturnValue({ data: country, isLoading: false, isError: false });
    mockUseCountrySummaryQuery.mockReturnValue({
      data: {
        countryId: 1,
        tenantCount: 2,
        activeTenantCount: 2,
        campaignCount: 0,
        tenants: [
          { id: 10, code: 'T001', name: 'Tenant One', status: 'active' },
          { id: 11, code: 'T002', name: 'Tenant Two', status: 'active' },
        ],
      },
      isLoading: false,
    });
    const user = userEvent.setup();

    renderPage();
    await user.click(screen.getByRole('button', { name: /^deactivate$/i }));

    // The warning is surfaced, not applied silently — no mutation yet.
    expect(mockMutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /deactivate anyway/i }));
    expect(mockMutate).toHaveBeenCalledWith(
      { status: 'inactive', confirm: true },
      expect.objectContaining({ onSuccess: expect.any(Function) as unknown }),
    );
  });

  it('offers Activate instead of Deactivate for an inactive country', () => {
    mockUseCountryQuery.mockReturnValue({
      data: { ...country, status: 'inactive' },
      isLoading: false,
      isError: false,
    });
    mockUseCountrySummaryQuery.mockReturnValue({
      data: { countryId: 1, tenantCount: 0, activeTenantCount: 0, campaignCount: 0, tenants: [] },
      isLoading: false,
    });

    renderPage();

    expect(screen.getByRole('button', { name: /^activate$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^deactivate$/i })).not.toBeInTheDocument();
  });

  it('shows an error state when the country cannot be loaded', () => {
    mockUseCountryQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: null,
    });
    mockUseCountrySummaryQuery.mockReturnValue({ data: undefined, isLoading: false });

    renderPage();

    expect(screen.getByText('Could not load this country', { exact: true })).toBeInTheDocument();
  });
});
