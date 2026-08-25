import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { User } from '@reward-portal/shared';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';

const { mockUseUsersQuery } = vi.hoisted(() => ({ mockUseUsersQuery: vi.fn() }));

vi.mock('./api', () => ({ useUsersQuery: mockUseUsersQuery }));
// AddUserModal pulls in the real mutation hooks / countries / tenants apis; stubbed out here
// since this suite only exercises the list screen, not the create flow (covered by
// AddUserModal.test.tsx).
vi.mock('./AddUserModal', () => ({
  AddUserModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-user-modal" /> : null,
}));

import { UsersListPage } from './UsersListPage';

const users: User[] = [
  {
    id: 100,
    email: 'maker@example.invalid',
    displayName: 'Maker One',
    role: 'maker',
    countryId: 1,
    tenantId: 10,
    merchantId: null,
    status: 'active',
    mustChangePassword: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 101,
    email: 'checker@example.invalid',
    displayName: 'Checker One',
    role: 'checker',
    countryId: 1,
    tenantId: 10,
    merchantId: null,
    status: 'inactive',
    mustChangePassword: false,
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
      entity === 'user' && action === 'create' ? canCreate : true,
    refetch: () => undefined,
  };
}

function renderPage(canCreate: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(canCreate)}>
        <MemoryRouter initialEntries={['/users']}>
          <Routes>
            <Route path="/users" element={<UsersListPage />} />
            <Route path="/users/:id" element={<div>User detail screen</div>} />
          </Routes>
        </MemoryRouter>
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUseUsersQuery.mockReset();
});

describe('UsersListPage', () => {
  it('renders every user row', () => {
    mockUseUsersQuery.mockReturnValue({
      data: { data: users, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });

    renderPage(true);

    expect(screen.getByText('Maker One')).toBeInTheDocument();
    expect(screen.getByText('Checker One')).toBeInTheDocument();
  });

  it('shows "Add user" only when the caller holds user:create (R6)', () => {
    mockUseUsersQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });

    renderPage(false);
    expect(screen.queryByRole('button', { name: /add user/i })).not.toBeInTheDocument();
  });

  it('opens the Add User modal when the button is clicked', async () => {
    mockUseUsersQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByRole('button', { name: /add user/i }));

    expect(screen.getByTestId('add-user-modal')).toBeInTheDocument();
  });

  it('navigates to the user detail screen when a row is clicked', async () => {
    mockUseUsersQuery.mockReturnValue({
      data: { data: users, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByText('Maker One'));

    await waitFor(() => {
      expect(screen.getByText('User detail screen')).toBeInTheDocument();
    });
  });

  it('renders an empty state when there are no users', () => {
    mockUseUsersQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });

    renderPage(true);
    expect(screen.getByText('No users yet')).toBeInTheDocument();
  });

  it('shows the loading state', () => {
    mockUseUsersQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderPage(true);
    expect(screen.getByRole('status', { name: /loading table data/i })).toBeInTheDocument();
  });

  it('shows the server error message when the list fails to load', () => {
    mockUseUsersQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new ApiError({ code: 'PERM_DENIED', message: 'You may not view this.', status: 403 }),
    });
    renderPage(true);
    expect(screen.getByRole('alert')).toHaveTextContent('You may not view this.');
  });

  it('re-requests the next page', async () => {
    mockUseUsersQuery.mockReturnValue({
      data: { data: users, meta: { page: 1, pageSize: 1, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);
    await user.click(screen.getByRole('button', { name: /^next$/i }));

    const lastCall = mockUseUsersQuery.mock.calls.at(-1)?.[0] as { page: number };
    expect(lastCall.page).toBe(2);
  });

  it('toggles sort direction on repeated header clicks, resetting back to page 1', async () => {
    mockUseUsersQuery.mockReturnValue({
      data: { data: users, meta: { page: 1, pageSize: 1, total: 2 } },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();

    renderPage(true);

    const sortButton = screen
      .getByRole('columnheader', { name: /email/i })
      .querySelector('button')!;
    await user.click(sortButton); // 'displayName:asc' -> 'email:asc' (a different column resets to asc)
    await user.click(sortButton); // 'email:asc' -> 'email:desc' (same column toggles)

    const lastCall = mockUseUsersQuery.mock.calls.at(-1)?.[0] as {
      page: number;
      sort: string;
    };
    expect(lastCall.sort).toBe('email:desc');
    expect(lastCall.page).toBe(1);
  });

  it('renders a status badge for every ck_portal_users_status value', () => {
    mockUseUsersQuery.mockReturnValue({
      data: {
        data: [
          { ...users[0], status: 'active' },
          { ...users[1], status: 'inactive' },
        ],
        meta: { page: 1, pageSize: 20, total: 2 },
      },
      isLoading: false,
      error: null,
    });

    renderPage(true);
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('inactive')).toBeInTheDocument();
  });

  it('renders the human-readable role label, not the raw enum value', () => {
    mockUseUsersQuery.mockReturnValue({
      data: { data: users, meta: { page: 1, pageSize: 20, total: 2 } },
      isLoading: false,
      error: null,
    });

    renderPage(true);
    expect(screen.getByText('Maker')).toBeInTheDocument();
    expect(screen.getByText('Checker')).toBeInTheDocument();
  });
});
