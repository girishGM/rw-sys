import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChangePasswordPage } from '../../../src/features/auth/ChangePasswordPage';

const { mockGet, mockPost, mockToastSuccess } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

// Both `lib/apiClient.ts`'s `api` and `auth/useBootstrap.ts`'s bare bootstrap instance call
// `axios.create(...)` — mocking at that level, exactly as `test/auth/router.spec.tsx` already
// does, covers both call sites this screen exercises with one mock.
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return {
    default: {
      ...actual.default,
      create: () => ({
        get: mockGet,
        post: mockPost,
        interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
      }),
    },
  };
});

vi.mock('../../../src/components/toastActions', () => ({
  toast: { success: mockToastSuccess, error: vi.fn() },
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/change-password']}>
        <Routes>
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function fillForm({
  current = 'OldPassword1!',
  next = 'CorrectHorse1!',
  confirm = next,
}: {
  current?: string;
  next?: string;
  confirm?: string;
}) {
  await userEvent.type(screen.getByLabelText('Current password'), current);
  await userEvent.type(screen.getByLabelText('New password'), next);
  await userEvent.type(screen.getByLabelText('Confirm new password'), confirm);
}

function rejectWithCode(status: number, code: string, message: string, details?: unknown) {
  return {
    isAxiosError: true,
    response: { status, data: { error: { code, message, details } } },
    message: `Request failed with status code ${status}`,
  };
}

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockToastSuccess.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('ChangePasswordPage', () => {
  it('redirects to /login when there is no session at all (401)', async () => {
    mockGet.mockRejectedValue({ isAxiosError: true, response: { status: 401 }, message: 'x' });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/login'));
  });

  it('T-024 TC-6/TC-7: shows a confinement notice for a 403 PASSWORD_CHANGE_REQUIRED session, and still renders the form', async () => {
    mockGet.mockRejectedValue(
      rejectWithCode(403, 'PASSWORD_CHANGE_REQUIRED', 'Password change required'),
    );
    renderPage();
    await screen.findByText('Your account requires a new password before you can continue.');
    expect(screen.getByRole('heading', { name: 'Change your password' })).toBeInTheDocument();
    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
  });

  it('does not show the confinement notice for a normal, non-confined session', async () => {
    mockGet.mockResolvedValue({
      data: {
        data: {
          user: { id: 1, displayName: 'Ada', role: 'maker', locale: 'en', timezone: null },
          scope: { countryId: null, tenantId: null, merchantId: null },
          nav: [],
          permissions: {},
          widgets: [],
          messages: {},
        },
      },
    });
    renderPage();
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(
      screen.queryByText('Your account requires a new password before you can continue.'),
    ).not.toBeInTheDocument();
  });

  it('TC-10: a successful change toasts, then redirects to /dashboard', async () => {
    mockGet.mockRejectedValue(
      rejectWithCode(403, 'PASSWORD_CHANGE_REQUIRED', 'Password change required'),
    );
    mockPost.mockResolvedValue({ data: undefined });
    renderPage();
    await screen.findByText('Your account requires a new password before you can continue.');
    await fillForm({});
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/dashboard'));
    expect(mockToastSuccess).toHaveBeenCalledWith('Password changed.');
    expect(mockPost).toHaveBeenCalledWith('/auth/change-password', {
      currentPassword: 'OldPassword1!',
      newPassword: 'CorrectHorse1!',
    });
  });

  it('TC-8: a weak new password shows an inline error before submit', async () => {
    mockGet.mockRejectedValue(
      rejectWithCode(403, 'PASSWORD_CHANGE_REQUIRED', 'Password change required'),
    );
    renderPage();
    await screen.findByText('Your account requires a new password before you can continue.');
    await fillForm({ next: 'short1!', confirm: 'short1!' });
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/at least 12 characters/)).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('TC-9: a mismatched confirmation shows an inline error before submit', async () => {
    mockGet.mockRejectedValue(
      rejectWithCode(403, 'PASSWORD_CHANGE_REQUIRED', 'Password change required'),
    );
    renderPage();
    await screen.findByText('Your account requires a new password before you can continue.');
    await fillForm({ next: 'CorrectHorse1!', confirm: 'Different1!' });
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('TC-11: reusing one of the last 5 passwords renders the server error clearly', async () => {
    mockGet.mockRejectedValue(
      rejectWithCode(403, 'PASSWORD_CHANGE_REQUIRED', 'Password change required'),
    );
    mockPost.mockRejectedValue(
      rejectWithCode(400, 'AUTH_PASSWORD_POLICY', 'Password policy violation', [
        { field: 'newPassword', code: 'password_reused' },
      ]),
    );
    renderPage();
    await screen.findByText('Your account requires a new password before you can continue.');
    await fillForm({});
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(
      await screen.findByText("You've used this password recently. Choose a different one."),
    ).toBeInTheDocument();
  });

  it('a generic failure (not policy, not wrong-current-password) renders the fallback banner', async () => {
    mockGet.mockRejectedValue(
      rejectWithCode(403, 'PASSWORD_CHANGE_REQUIRED', 'Password change required'),
    );
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: undefined,
      message: 'Network Error',
    });
    renderPage();
    await screen.findByText('Your account requires a new password before you can continue.');
    await fillForm({});
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/offline|can't be reached/i);
  });

  it('a wrong current password renders inline on that field', async () => {
    mockGet.mockRejectedValue(
      rejectWithCode(403, 'PASSWORD_CHANGE_REQUIRED', 'Password change required'),
    );
    mockPost.mockRejectedValue(
      rejectWithCode(401, 'AUTH_INVALID_CREDENTIALS', 'The email or password is incorrect.'),
    );
    renderPage();
    await screen.findByText('Your account requires a new password before you can continue.');
    await fillForm({});
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The email or password is incorrect.')).toBeInTheDocument();
    expect(screen.getByLabelText('Current password')).toHaveValue('');
  });
});
