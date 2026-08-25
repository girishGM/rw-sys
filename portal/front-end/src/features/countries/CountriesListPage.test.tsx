import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Country } from '@reward-portal/shared';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';

const { mockUseCountriesQuery } = vi.hoisted(() => ({ mockUseCountriesQuery: vi.fn() }));

vi.mock('./api', () => ({ useCountriesQuery: mockUseCountriesQuery }));
// AddCountryModal pulls in the real mutation hooks / apiClient; stubbed out here since this
// suite only exercises the list screen, not the create flow (covered by AddCountryModal.test.tsx).
vi.mock('./AddCountryModal', () => ({
  AddCountryModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-country-modal" /> : null,
}));

import { CountriesListPage } from './CountriesListPage';

const countries: Country[] = [
  {
    id: 1,
    code: 'MY',
    name: 'Malaysia',
    timezone: 'Asia/Kuala_Lumpur',
    currencyCode: 'MYR',
    dialingCode: '+60',
    isHq: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 2,
    code: 'SG',
    name: 'Singapore',
    timezone: 'Asia/Singapore',
    currencyCode: 'SGD',
    dialingCode: '+65',
    isHq: false,
    status: 'inactive',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
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
      entity === 'country' && action === 'create' ? canCreate : true,
    refetch: () => undefined,
  };
}

function renderPage(canCreate: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(canCreate)}>
        <MemoryRouter initialEntries={['/countries']}>
          <Routes>
            <Route path="/countries" element={<CountriesListPage />} />
            <Route path="/countries/:id" element={<div>Country detail screen</div>} />
          </Routes>
        </MemoryRouter>
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUseCountriesQuery.mockReset();
});

describe('CountriesListPage', () => {
  it('renders every country row', () => {
    mockUseCountriesQuery.mockReturnValue({
      data: { data: countries, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });

    renderPage(true);

    expect(screen.getByText('Malaysia')).toBeInTheDocument();
    expect(screen.getByText('Singapore')).toBeInTheDocument();
  });

  it('shows "Add country" only when the caller holds country:create (TC-8, 00-ARCHITECTURE.md §7)', () => {
    mockUseCountriesQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });

    renderPage(false);
    expect(screen.queryByRole('button', { name: /add country/i })).not.toBeInTheDocument();
  });

  it('opens the Add Country modal when the button is clicked', async () => {
    mockUseCountriesQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByRole('button', { name: /add country/i }));

    expect(screen.getByTestId('add-country-modal')).toBeInTheDocument();
  });

  it('navigates to the country detail screen when a row is clicked', async () => {
    mockUseCountriesQuery.mockReturnValue({
      data: { data: countries, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByText('Malaysia'));

    await waitFor(() => {
      expect(screen.getByText('Country detail screen')).toBeInTheDocument();
    });
  });

  it('renders an empty state when there are no countries', () => {
    mockUseCountriesQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });

    renderPage(true);
    expect(screen.getByText('No countries yet')).toBeInTheDocument();
  });

  it('shows the loading state', () => {
    mockUseCountriesQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderPage(true);
    expect(screen.getByRole('status', { name: /loading table data/i })).toBeInTheDocument();
  });

  it('shows the server error message when the list fails to load', () => {
    mockUseCountriesQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new ApiError({ code: 'PERM_DENIED', message: 'You may not view this.', status: 403 }),
    });
    renderPage(true);
    expect(screen.getByRole('alert')).toHaveTextContent('You may not view this.');
  });

  it('re-requests the next page', async () => {
    mockUseCountriesQuery.mockReturnValue({
      data: { data: countries, meta: { page: 1, pageSize: 1, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByRole('button', { name: /^next$/i }));

    const lastCall = mockUseCountriesQuery.mock.calls.at(-1)?.[0] as { page: number };
    expect(lastCall.page).toBe(2);
  });

  it('toggles sort direction on repeated header clicks, resetting back to page 1', async () => {
    mockUseCountriesQuery.mockReturnValue({
      data: { data: countries, meta: { page: 1, pageSize: 1, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);

    const sortButton = screen.getByRole('columnheader', { name: /code/i }).querySelector('button')!;
    await user.click(sortButton); // 'name:asc' -> 'code:asc' (a different column resets to asc)
    await user.click(sortButton); // 'code:asc' -> 'code:desc' (same column toggles)

    const lastCall = mockUseCountriesQuery.mock.calls.at(-1)?.[0] as {
      page: number;
      sort: string;
    };
    expect(lastCall.sort).toBe('code:desc');
    // Changing the sort starts back at page 1 — a stale offset into the old ordering would show
    // the wrong rows.
    expect(lastCall.page).toBe(1);
  });
});
