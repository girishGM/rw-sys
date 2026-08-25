import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ResetPasswordPage } from '../../../src/features/auth/ResetPasswordPage';

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }));

vi.mock('../../../src/lib/apiClient', () => ({ api: { post: mockPost } }));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderPage(initialEntry = '/reset-password?token=tok-123') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function fillNewPassword(value: string) {
  await userEvent.type(screen.getByLabelText('New password'), value);
  await userEvent.type(screen.getByLabelText('Confirm new password'), value);
}

beforeEach(() => {
  mockPost.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('ResetPasswordPage', () => {
  it('submits the token from the URL alongside the new password', async () => {
    mockPost.mockResolvedValue({ data: undefined });
    renderPage('/reset-password?token=abc-987');
    await fillNewPassword('CorrectHorse1!');
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/auth/reset-password', {
        token: 'abc-987',
        newPassword: 'CorrectHorse1!',
      }),
    );
  });

  it('redirects to /login on success', async () => {
    mockPost.mockResolvedValue({ data: undefined });
    renderPage();
    await fillNewPassword('CorrectHorse1!');
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/login'));
  });

  it('TC-9: mismatched confirmation shows an inline error before submit', async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText('New password'), 'CorrectHorse1!');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'Different1!');
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('TC-8: a weak password shows an inline error before submit, without calling the API', async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText('New password'), 'short1!');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'short1!');
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    expect(await screen.findByText(/at least 12 characters/)).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('a policy-violating new password (server round trip) renders the violation inline', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          error: {
            code: 'AUTH_PASSWORD_POLICY',
            message: 'Password policy violation',
            details: [{ field: 'newPassword', code: 'common_password' }],
          },
        },
      },
    });
    renderPage();
    await fillNewPassword('CorrectHorse1!');
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    expect(
      await screen.findByText('This password is too common. Choose something less predictable.'),
    ).toBeInTheDocument();
  });

  it('TC-14: an expired token shows "expired or invalid"', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          error: {
            code: 'AUTH_RESET_TOKEN_INVALID',
            message: 'This link has expired or is invalid.',
          },
        },
      },
    });
    renderPage();
    await fillNewPassword('CorrectHorse1!');
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('This link has expired or is invalid.');
  });

  it('TC-15: an already-used token renders the byte-identical message to TC-14', async () => {
    // Same exception, same code, same message — nothing here can diverge from TC-14.
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          error: {
            code: 'AUTH_RESET_TOKEN_INVALID',
            message: 'This link has expired or is invalid.',
          },
        },
      },
    });
    renderPage();
    await fillNewPassword('CorrectHorse1!');
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('This link has expired or is invalid.');
  });

  it('does not pre-check the token: no request is made before the user submits', () => {
    renderPage('/reset-password?token=maybe-invalid');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('renders the form even with no token in the URL at all, deferring to the same generic failure on submit', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          error: {
            code: 'AUTH_RESET_TOKEN_INVALID',
            message: 'This link has expired or is invalid.',
          },
        },
      },
    });
    renderPage('/reset-password');
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();
    await fillNewPassword('CorrectHorse1!');
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This link has expired or is invalid.',
    );
  });
});
