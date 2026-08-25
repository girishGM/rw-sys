import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DefinitionRequest } from '@reward-portal/shared';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';

const { mockUseDefinitionRequestsQuery } = vi.hoisted(() => ({
  mockUseDefinitionRequestsQuery: vi.fn(),
}));

vi.mock('./api', () => ({ useDefinitionRequestsQuery: mockUseDefinitionRequestsQuery }));
vi.mock('./SubmitDefinitionRequestModal', () => ({
  SubmitDefinitionRequestModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="submit-request-modal" /> : null,
}));

import { DefinitionRequestsListPage } from './DefinitionRequestsListPage';

function requestRow(overrides: Partial<DefinitionRequest> = {}): DefinitionRequest {
  return {
    id: 1,
    requestType: 'new_rule',
    entityId: null,
    requestedBy: 1,
    requestingCountryId: 9,
    requestingTenantId: null,
    title: 'Weekend multiplier',
    description: 'We need a weekend multiplier rule.',
    businessJustification: null,
    desiredBy: null,
    priority: 'normal',
    status: 'submitted',
    reviewedBy: null,
    reviewedAt: null,
    reviewComment: null,
    fulfilledVersionId: null,
    fulfilledAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const rows: DefinitionRequest[] = [
  requestRow({ id: 1, title: 'Weekend multiplier' }),
  requestRow({
    id: 2,
    title: 'Loyalty tier reward',
    requestType: 'new_reward',
    status: 'approved',
  }),
];

function bootstrapValue(canCreate: boolean): BootstrapContextValue {
  return {
    user: { id: 1, displayName: 'Test User', role: 'country_admin', locale: 'en', timezone: null },
    scope: { countryId: 9, tenantId: null, merchantId: null },
    nav: [],
    permissions: {},
    widgets: [],
    messages: {},
    isLoading: false,
    isError: false,
    isUnauthorized: false,
    hasPermission: (entity, action) =>
      entity === 'definition_request' && action === 'create' ? canCreate : true,
    refetch: () => undefined,
  };
}

function renderPage(canCreate: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(canCreate)}>
        <MemoryRouter initialEntries={['/definition-requests']}>
          <Routes>
            <Route path="/definition-requests" element={<DefinitionRequestsListPage />} />
            <Route path="/definition-requests/:id" element={<div>Detail screen</div>} />
          </Routes>
        </MemoryRouter>
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUseDefinitionRequestsQuery.mockReset();
});

describe('DefinitionRequestsListPage', () => {
  it('renders every request row', () => {
    mockUseDefinitionRequestsQuery.mockReturnValue({
      data: { data: rows, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });

    renderPage(true);

    expect(screen.getByText('Weekend multiplier')).toBeInTheDocument();
    expect(screen.getByText('Loyalty tier reward')).toBeInTheDocument();
  });

  it('shows "New request" for a caller holding definition_request:create (country_admin/tenant_admin)', () => {
    mockUseDefinitionRequestsQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });

    renderPage(true);
    expect(screen.getByRole('button', { name: /new request/i })).toBeInTheDocument();
  });

  it('hides "New request" for a caller without definition_request:create — read-only', () => {
    mockUseDefinitionRequestsQuery.mockReturnValue({
      data: { data: rows, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });

    renderPage(false);
    expect(screen.queryByRole('button', { name: /new request/i })).not.toBeInTheDocument();
    expect(screen.getByText('Weekend multiplier')).toBeInTheDocument();
  });

  it('opens the submit modal when the button is clicked', async () => {
    mockUseDefinitionRequestsQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByRole('button', { name: /new request/i }));

    expect(screen.getByTestId('submit-request-modal')).toBeInTheDocument();
  });

  it('navigates to the detail screen when a row is clicked', async () => {
    mockUseDefinitionRequestsQuery.mockReturnValue({
      data: { data: rows, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByText('Weekend multiplier'));

    await waitFor(() => {
      expect(screen.getByText('Detail screen')).toBeInTheDocument();
    });
  });

  it('renders an empty state when there are no requests', () => {
    mockUseDefinitionRequestsQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });

    renderPage(true);
    expect(screen.getByText('No definition requests yet')).toBeInTheDocument();
  });

  it('shows the server error message when the list fails to load', () => {
    mockUseDefinitionRequestsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new ApiError({ code: 'PERM_DENIED', message: 'You may not view this.', status: 403 }),
    });
    renderPage(true);
    expect(screen.getByRole('alert')).toHaveTextContent('You may not view this.');
  });

  it('re-requests with a status filter (TC-21)', async () => {
    mockUseDefinitionRequestsQuery.mockReturnValue({
      data: { data: rows, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByRole('combobox', { name: /^status/i }));
    await user.click(screen.getByRole('option', { name: 'submitted' }));

    const lastCall = mockUseDefinitionRequestsQuery.mock.calls.at(-1)?.[0] as {
      status?: string;
    };
    expect(lastCall.status).toBe('submitted');
  });
});
