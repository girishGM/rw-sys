import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Merchant } from '@reward-portal/shared';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';

const { mockUseMerchantsQuery } = vi.hoisted(() => ({ mockUseMerchantsQuery: vi.fn() }));

vi.mock('./api', () => ({ useMerchantsQuery: mockUseMerchantsQuery }));
// AddMerchantModal pulls in the real mutation hooks / apiClient; stubbed out here since this
// suite only exercises the list screen, not the create flow (covered by AddMerchantModal.test.tsx).
vi.mock('./AddMerchantModal', () => ({
  AddMerchantModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-merchant-modal" /> : null,
}));

import { MerchantsListPage } from './MerchantsListPage';

const merchants: Merchant[] = [
  {
    id: 100,
    tenantId: 10,
    merchantCode: 'M001',
    name: 'Acme Store',
    description: null,
    contactEmail: null,
    contactPhone: null,
    website: null,
    countryCode: 'MY',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 101,
    tenantId: 10,
    merchantCode: 'M002',
    name: 'Globex Retail',
    description: null,
    contactEmail: null,
    contactPhone: null,
    website: null,
    countryCode: 'MY',
    status: 'inactive',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

function bootstrapValue(canCreate: boolean): BootstrapContextValue {
  return {
    user: { id: 1, displayName: 'Test User', role: 'tenant_admin', locale: 'en', timezone: null },
    scope: { countryId: 1, tenantId: 10, merchantId: null },
    nav: [],
    permissions: {},
    widgets: [],
    messages: {},
    isLoading: false,
    isError: false,
    isUnauthorized: false,
    hasPermission: (entity, action) =>
      entity === 'merchant' && action === 'create' ? canCreate : true,
    refetch: () => undefined,
  };
}

function renderPage(canCreate: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(canCreate)}>
        <MemoryRouter initialEntries={['/merchants']}>
          <Routes>
            <Route path="/merchants" element={<MerchantsListPage />} />
            <Route path="/merchants/:id" element={<div>Merchant detail screen</div>} />
          </Routes>
        </MemoryRouter>
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUseMerchantsQuery.mockReset();
});

describe('MerchantsListPage', () => {
  it('renders every merchant row', () => {
    mockUseMerchantsQuery.mockReturnValue({
      data: { data: merchants, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });

    renderPage(true);

    expect(screen.getByText('Acme Store')).toBeInTheDocument();
    expect(screen.getByText('Globex Retail')).toBeInTheDocument();
  });

  it('shows "Add merchant" only when the caller holds merchant:create (TC-6/TC-7)', () => {
    mockUseMerchantsQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });

    renderPage(false);
    expect(screen.queryByRole('button', { name: /add merchant/i })).not.toBeInTheDocument();
  });

  it('opens the Add Merchant modal when the button is clicked', async () => {
    mockUseMerchantsQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByRole('button', { name: /add merchant/i }));

    expect(screen.getByTestId('add-merchant-modal')).toBeInTheDocument();
  });

  it('navigates to the merchant detail screen when a row is clicked', async () => {
    mockUseMerchantsQuery.mockReturnValue({
      data: { data: merchants, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByText('Acme Store'));

    await waitFor(() => {
      expect(screen.getByText('Merchant detail screen')).toBeInTheDocument();
    });
  });

  it('renders an empty state when there are no merchants', () => {
    mockUseMerchantsQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });

    renderPage(true);
    expect(screen.getByText('No merchants yet')).toBeInTheDocument();
  });

  it('shows the loading state', () => {
    mockUseMerchantsQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderPage(true);
    expect(screen.getByRole('status', { name: /loading table data/i })).toBeInTheDocument();
  });

  it('shows the server error message when the list fails to load', () => {
    mockUseMerchantsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new ApiError({ code: 'PERM_DENIED', message: 'You may not view this.', status: 403 }),
    });
    renderPage(true);
    expect(screen.getByRole('alert')).toHaveTextContent('You may not view this.');
  });

  it('submits a search term, resetting back to page 1 (TC-21)', async () => {
    mockUseMerchantsQuery.mockReturnValue({
      data: { data: merchants, meta: { page: 2, pageSize: 20, total: 40 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.type(screen.getByPlaceholderText(/search by code or name/i), 'acme');
    await user.click(screen.getByRole('button', { name: /^search$/i }));

    const lastCall = mockUseMerchantsQuery.mock.calls.at(-1)?.[0] as {
      page: number;
      search?: string;
    };
    expect(lastCall.search).toBe('acme');
    expect(lastCall.page).toBe(1);
  });

  it('re-requests the next page', async () => {
    mockUseMerchantsQuery.mockReturnValue({
      data: { data: merchants, meta: { page: 1, pageSize: 1, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByRole('button', { name: /^next$/i }));

    const lastCall = mockUseMerchantsQuery.mock.calls.at(-1)?.[0] as { page: number };
    expect(lastCall.page).toBe(2);
  });

  it('toggles sort direction on repeated header clicks, resetting back to page 1', async () => {
    mockUseMerchantsQuery.mockReturnValue({
      data: { data: merchants, meta: { page: 1, pageSize: 1, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);

    const sortButton = screen.getByRole('columnheader', { name: /code/i }).querySelector('button')!;
    await user.click(sortButton); // 'name:asc' -> 'merchantCode:asc'
    await user.click(sortButton); // 'merchantCode:asc' -> 'merchantCode:desc'

    const lastCall = mockUseMerchantsQuery.mock.calls.at(-1)?.[0] as {
      page: number;
      sort: string;
    };
    expect(lastCall.sort).toBe('merchantCode:desc');
    expect(lastCall.page).toBe(1);
  });

  it('renders a status badge for every ck_m_status value', () => {
    mockUseMerchantsQuery.mockReturnValue({
      data: {
        data: [
          { ...merchants[0], status: 'active' },
          { ...merchants[1], status: 'suspended' },
        ],
        meta: { page: 1, pageSize: 20, total: 2 },
      },
      isLoading: false,
      error: null,
    });

    renderPage(true);
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('suspended')).toBeInTheDocument();
  });
});
