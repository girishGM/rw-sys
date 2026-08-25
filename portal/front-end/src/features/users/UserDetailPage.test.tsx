import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';

const {
  mockUseUserQuery,
  mockUseDeactivateUserMutation,
  mockUseResetUserPasswordMutation,
  mockDeactivate,
  mockResetMutateAsync,
} = vi.hoisted(() => ({
  mockUseUserQuery: vi.fn(),
  mockUseDeactivateUserMutation: vi.fn(),
  mockUseResetUserPasswordMutation: vi.fn(),
  mockDeactivate: vi.fn(),
  mockResetMutateAsync: vi.fn(),
}));

vi.mock('./api', () => ({
  useUserQuery: mockUseUserQuery,
  useDeactivateUserMutation: mockUseDeactivateUserMutation,
  useResetUserPasswordMutation: mockUseResetUserPasswordMutation,
}));

import { UserDetailPage } from './UserDetailPage';

const targetUser = {
  id: 500,
  email: 'maker@example.invalid',
  displayName: 'A Maker',
  role: 'maker' as const,
  countryId: 1,
  tenantId: 10,
  merchantId: null,
  status: 'active' as const,
  mustChangePassword: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function bootstrapValue(actorId: number): BootstrapContextValue {
  return {
    user: {
      id: actorId,
      displayName: 'Test User',
      role: 'tenant_admin',
      locale: 'en',
      timezone: null,
    },
    scope: { countryId: 1, tenantId: 10, merchantId: null },
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

function renderPage(actorId = 1, initialPath = '/users/500') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(actorId)}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/users/:id" element={<UserDetailPage />} />
          </Routes>
        </MemoryRouter>
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUseUserQuery.mockReset();
  mockUseDeactivateUserMutation.mockReset();
  mockUseResetUserPasswordMutation.mockReset();
  mockDeactivate.mockReset();
  mockResetMutateAsync.mockReset();
  mockUseDeactivateUserMutation.mockReturnValue({ mutate: mockDeactivate, isPending: false });
  mockUseResetUserPasswordMutation.mockReturnValue({
    mutateAsync: mockResetMutateAsync,
    isPending: false,
  });
});

describe('UserDetailPage', () => {
  it('renders the user name, email, role and status', () => {
    mockUseUserQuery.mockReturnValue({ data: targetUser, isLoading: false, isError: false });

    renderPage();

    expect(screen.getByRole('heading', { name: 'A Maker' })).toBeInTheDocument();
    expect(screen.getByText('maker@example.invalid')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('Maker')).toBeInTheDocument();
  });

  it("renders a merchant row's full scope triple, and falls back to em-dash for a country/tenant admin's absent axes", () => {
    mockUseUserQuery.mockReturnValue({
      data: {
        ...targetUser,
        role: 'merchant',
        merchantId: 20,
        countryId: null,
        tenantId: null,
        mustChangePassword: false,
      },
      isLoading: false,
      isError: false,
    });

    renderPage();

    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(2); // country and tenant
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it("TC-23: hides Deactivate when the viewed row is the signed-in actor's own", () => {
    mockUseUserQuery.mockReturnValue({ data: targetUser, isLoading: false, isError: false });
    renderPage(500); // actor id === target id

    expect(screen.queryByRole('button', { name: /deactivate/i })).not.toBeInTheDocument();
  });

  it('offers Deactivate for any other user, behind an explicit confirmation (TC-21)', async () => {
    mockUseUserQuery.mockReturnValue({ data: targetUser, isLoading: false, isError: false });
    const user = userEvent.setup();

    renderPage(1);
    await user.click(screen.getByRole('button', { name: /deactivate/i }));

    // The consequence is surfaced, not applied silently — no mutation yet.
    expect(mockDeactivate).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/logged out immediately/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /deactivate anyway/i }));
    expect(mockDeactivate).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ onSuccess: expect.any(Function) as unknown }),
    );
  });

  it('hides Deactivate for an already-inactive user', () => {
    mockUseUserQuery.mockReturnValue({
      data: { ...targetUser, status: 'inactive' },
      isLoading: false,
      isError: false,
    });
    renderPage(1);
    expect(screen.queryByRole('button', { name: /deactivate/i })).not.toBeInTheDocument();
  });

  it('TC-24: reveals a new one-time password on Reset password', async () => {
    mockUseUserQuery.mockReturnValue({ data: targetUser, isLoading: false, isError: false });
    mockResetMutateAsync.mockResolvedValue({
      ...targetUser,
      temporaryPassword: 'Xy9!kLmnpQ2*Zvwr4Tabcd7',
    });
    const user = userEvent.setup();

    renderPage(1);
    await user.click(screen.getByRole('button', { name: /reset password/i }));

    expect(await screen.findByTestId('temporary-password-value')).toBeInTheDocument();
    expect(mockResetMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('shows loading skeletons while the user is loading', () => {
    mockUseUserQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    renderPage();
    expect(screen.queryByRole('heading', { name: 'A Maker' })).not.toBeInTheDocument();
  });

  it('shows an error state when the user cannot be loaded', () => {
    mockUseUserQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: null,
    });
    renderPage();
    expect(screen.getByText('Could not load this user', { exact: true })).toBeInTheDocument();
  });

  it('shows the server error message when it is an ApiError instance (TC-19: 404 out of scope)', async () => {
    const { ApiError } = await import('../../lib/apiError');
    mockUseUserQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError({ code: 'NOT_FOUND', message: 'No such user.', status: 404 }),
    });
    renderPage();
    expect(screen.getByText('No such user.')).toBeInTheDocument();
  });

  it('shows an invalid-id message for a non-numeric route param', () => {
    mockUseUserQuery.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    renderPage(1, '/users/not-a-number');
    expect(screen.getByText('Invalid user id')).toBeInTheDocument();
  });
});
