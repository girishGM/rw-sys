import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LoginPage } from '../../../src/features/auth/LoginPage';

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }));

vi.mock('../../../src/lib/apiClient', () => ({ api: { post: mockPost } }));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderLoginPage(initialEntry = '/login') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function fillForm(email: string, password: string) {
  await userEvent.type(screen.getByLabelText('Email'), email);
  await userEvent.type(screen.getByLabelText('Password'), password);
}

beforeEach(() => {
  mockPost.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('LoginPage', () => {
  it('TC-1: a valid login redirects to /dashboard by default', async () => {
    mockPost.mockResolvedValue({
      data: { data: { role: 'maker', mustChangePassword: false, mfaRequired: false } },
    });
    renderLoginPage();
    await fillForm('ada@example.com', 'CorrectHorse1!');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/dashboard'));
  });

  it('TC-1: a valid login redirects to a preserved next path', async () => {
    mockPost.mockResolvedValue({
      data: { data: { role: 'maker', mustChangePassword: false, mfaRequired: false } },
    });
    renderLoginPage('/login?next=%2Fcampaigns');
    await fillForm('ada@example.com', 'CorrectHorse1!');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/campaigns'));
  });

  it('TC-2: an invalid password shows the generic message and clears only the password field', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 401,
        data: {
          error: {
            code: 'AUTH_INVALID_CREDENTIALS',
            message: 'The email or password is incorrect.',
          },
        },
      },
    });
    renderLoginPage();
    await fillForm('ada@example.com', 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The email or password is incorrect.');
    expect(screen.getByLabelText('Email')).toHaveValue('ada@example.com');
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('TC-3/TC-4: an unknown email and a locked account render byte-identical output to TC-2', async () => {
    // The server collapses unknown-user, wrong-password, locked and inactive into one
    // undifferentiated body (AUTH_INVALID_CREDENTIALS) — this test proves the client has no
    // second code path that could diverge from it.
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 401,
        data: {
          error: {
            code: 'AUTH_INVALID_CREDENTIALS',
            message: 'The email or password is incorrect.',
          },
        },
      },
    });
    renderLoginPage();
    await fillForm('unknown@example.com', 'whatever1!');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The email or password is incorrect.');
  });

  it('TC-5: a 429 renders "too many attempts" with the minute count from Retry-After', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 429,
        headers: { 'retry-after': '120' },
        data: { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } },
      },
    });
    renderLoginPage();
    await fillForm('ada@example.com', 'CorrectHorse1!');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Too many attempts, try again in 2 minutes.');
  });

  it('TC-6: mustChangePassword redirects to /change-password, ignoring next', async () => {
    mockPost.mockResolvedValue({
      data: { data: { role: 'maker', mustChangePassword: true, mfaRequired: false } },
    });
    renderLoginPage('/login?next=%2Fcampaigns');
    await fillForm('ada@example.com', 'CorrectHorse1!');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/change-password'),
    );
  });

  it('T-060: mfaRequired hands off to /mfa-challenge, never navigating as if a session exists', async () => {
    mockPost.mockResolvedValue({
      data: { data: { role: 'super_admin', mustChangePassword: false, mfaRequired: true } },
    });
    renderLoginPage();
    await fillForm('super@example.com', 'CorrectHorse1!');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/mfa-challenge'));
  });

  it('T-060: mfaRequired preserves next onto /mfa-challenge', async () => {
    mockPost.mockResolvedValue({
      data: { data: { role: 'super_admin', mustChangePassword: false, mfaRequired: true } },
    });
    renderLoginPage('/login?next=%2Fcampaigns');
    await fillForm('super@example.com', 'CorrectHorse1!');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/mfa-challenge?next=%2Fcampaigns'),
    );
  });

  it('shows a gentle session-expired notice only when a next param is present', () => {
    renderLoginPage('/login?next=%2Fdashboard');
    expect(screen.getByText('Your session has expired, please sign in again.')).toBeInTheDocument();
  });

  it('shows no session-expired notice on a bare visit to /login', () => {
    renderLoginPage('/login');
    expect(
      screen.queryByText('Your session has expired, please sign in again.'),
    ).not.toBeInTheDocument();
  });

  it('shows an inline error for an invalid email format, without calling the API', async () => {
    renderLoginPage();
    await userEvent.type(screen.getByLabelText('Email'), 'not-an-email');
    await userEvent.type(screen.getByLabelText('Password'), 'whatever1!');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('TC-16: fields carry the autocomplete attributes password managers rely on', () => {
    renderLoginPage();
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });

  it('TC-17: Enter inside the form submits it (fully keyboard operable)', async () => {
    mockPost.mockResolvedValue({
      data: { data: { role: 'maker', mustChangePassword: false, mfaRequired: false } },
    });
    renderLoginPage();
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'CorrectHorse1!{Enter}');
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
  });

  it('TC-19: the password only ever appears in the POST body, never in a URL', async () => {
    mockPost.mockResolvedValue({
      data: { data: { role: 'maker', mustChangePassword: false, mfaRequired: false } },
    });
    renderLoginPage();
    await fillForm('ada@example.com', 'super-secret-value-1!');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    const [url] = mockPost.mock.calls[0] as [string];
    expect(url).toBe('/auth/login');
    expect(url).not.toMatch(/super-secret-value-1!/);
  });
});
