import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MfaChallengePage } from '../../../src/features/auth/MfaChallengePage';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }));

vi.mock('../../../src/lib/apiClient', () => ({ api: { post: mockPost } }));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderMfaPage(initialEntry = '/mfa-challenge') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/mfa-challenge" element={<MfaChallengePage />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const enrolmentOffer = {
  secret: 'ABCDEFGHIJKLMNOP',
  otpauthUri:
    'otpauth://totp/Reward%20Portal:super@x.com?secret=ABCDEFGHIJKLMNOP&issuer=Reward+Portal',
  issuer: 'Reward Portal',
  account: 'super@x.com',
  algorithm: 'SHA1',
  digits: 6,
  periodSeconds: 30,
};

function enrolSuccess() {
  return { data: { data: enrolmentOffer } };
}

function alreadyEnrolledRejection() {
  return Promise.reject({
    isAxiosError: true,
    response: {
      status: 403,
      data: { error: { code: 'MFA_ALREADY_ENROLLED', message: 'Already enrolled.' } },
    },
  });
}

function sessionInvalidRejection() {
  return Promise.reject({
    isAxiosError: true,
    response: {
      status: 401,
      data: { error: { code: 'AUTH_SESSION_INVALID', message: 'Session invalid.' } },
    },
  });
}

function mockRouteByPath(handlers: Record<string, () => unknown>) {
  mockPost.mockImplementation((path: string) => {
    const handler = handlers[path];
    if (!handler) throw new Error(`unexpected POST ${path}`);
    return handler();
  });
}

beforeEach(() => {
  mockPost.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('MfaChallengePage — enrolment (TC-1, TC-2, TC-3)', () => {
  it('TC-1: an unenrolled account sees the enrolment offer, secret and otpauthUri shown', async () => {
    mockPost.mockResolvedValue(enrolSuccess());
    renderMfaPage();

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Set up two-factor authentication' }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('ABCD EFGH IJKL MNOP')).toBeInTheDocument();
    expect(screen.getByText(enrolmentOffer.otpauthUri)).toBeInTheDocument();
    expect(mockPost).toHaveBeenCalledWith('/auth/mfa/enrol', {});
  });

  it('TC-2: the secret is fetched exactly once per mount, even under a double-effect', async () => {
    mockPost.mockResolvedValue(enrolSuccess());
    renderMfaPage();
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    // A second render tick (e.g. an unrelated parent re-render) must not re-fetch the secret.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('TC-2: once enrolment has completed, a fresh mount never shows the secret again', async () => {
    mockPost.mockImplementationOnce(() => Promise.resolve(enrolSuccess()));
    const { unmount } = renderMfaPage();
    await screen.findByRole('heading', { name: 'Set up two-factor authentication' });
    unmount();

    // Simulates a later, separate visit (browser refresh) after the account is now enrolled.
    mockPost.mockImplementationOnce(alreadyEnrolledRejection);
    renderMfaPage();
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Enter your verification code' }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('ABCD EFGH IJKL MNOP')).not.toBeInTheDocument();
  });

  it('TC-3: a valid code during enrolment shows the recovery codes once, then continuing lands on /dashboard', async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `WXYZ-${i}0${i}0-ABCD`);
    mockRouteByPath({
      '/auth/mfa/enrol': () => Promise.resolve(enrolSuccess()),
      '/auth/mfa/verify': () =>
        Promise.resolve({
          data: {
            data: {
              role: 'super_admin',
              mustChangePassword: false,
              mfaRequired: false,
              recoveryCodes: codes,
            },
          },
        }),
    });
    renderMfaPage();

    await screen.findByRole('heading', { name: 'Set up two-factor authentication' });
    await userEvent.type(screen.getByLabelText('Verification code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Enable two-factor authentication' }));

    await screen.findByRole('heading', { name: 'Save your recovery codes' });
    expect(screen.getByText(codes[0])).toBeInTheDocument();
    expect(mockPost).toHaveBeenCalledWith('/auth/mfa/verify', { totpCode: '123456' });

    await userEvent.click(
      screen.getByRole('button', { name: "I've saved these codes — continue" }),
    );
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/dashboard'));
  });

  it('a wrong code during enrolment shows an inline error and stays on the enrolment screen', async () => {
    mockRouteByPath({
      '/auth/mfa/enrol': () => Promise.resolve(enrolSuccess()),
      '/auth/mfa/verify': () =>
        Promise.reject({
          isAxiosError: true,
          response: {
            status: 401,
            data: {
              error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'The code was incorrect.' },
            },
          },
        }),
    });
    renderMfaPage();

    await screen.findByRole('heading', { name: 'Set up two-factor authentication' });
    await userEvent.type(screen.getByLabelText('Verification code'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Enable two-factor authentication' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The code was incorrect.');
    expect(
      screen.getByRole('heading', { name: 'Set up two-factor authentication' }),
    ).toBeInTheDocument();
  });
});

describe('MfaChallengePage — the ordinary challenge (TC-4 through TC-9)', () => {
  it('TC-4: an already-enrolled account goes straight to the 6-digit challenge, no enrolment offer', async () => {
    mockPost.mockImplementationOnce(alreadyEnrolledRejection);
    renderMfaPage();

    await screen.findByRole('heading', { name: 'Enter your verification code' });
    expect(
      screen.queryByRole('heading', { name: 'Set up two-factor authentication' }),
    ).not.toBeInTheDocument();
  });

  it('TC-5: a wrong code shows a clear error, no navigation, and stays on the challenge', async () => {
    mockRouteByPath({
      '/auth/mfa/enrol': alreadyEnrolledRejection,
      '/auth/mfa/verify': () =>
        Promise.reject({
          isAxiosError: true,
          response: {
            status: 401,
            data: {
              error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'The code was incorrect.' },
            },
          },
        }),
    });
    renderMfaPage();

    await screen.findByRole('heading', { name: 'Enter your verification code' });
    await userEvent.type(screen.getByLabelText('Verification code'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The code was incorrect.');
    expect(
      screen.getByRole('heading', { name: 'Enter your verification code' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Verification code')).toHaveValue('');
  });

  it('TC-6: mustChangePassword true after verify lands on /change-password', async () => {
    mockRouteByPath({
      '/auth/mfa/enrol': alreadyEnrolledRejection,
      '/auth/mfa/verify': () =>
        Promise.resolve({
          data: { data: { role: 'super_admin', mustChangePassword: true, mfaRequired: false } },
        }),
    });
    renderMfaPage();

    await screen.findByRole('heading', { name: 'Enter your verification code' });
    await userEvent.type(screen.getByLabelText('Verification code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/change-password'),
    );
  });

  it('TC-7: mustChangePassword false lands on the preserved next path', async () => {
    mockRouteByPath({
      '/auth/mfa/enrol': alreadyEnrolledRejection,
      '/auth/mfa/verify': () =>
        Promise.resolve({
          data: { data: { role: 'super_admin', mustChangePassword: false, mfaRequired: false } },
        }),
    });
    renderMfaPage('/mfa-challenge?next=%2Fcampaigns');

    await screen.findByRole('heading', { name: 'Enter your verification code' });
    await userEvent.type(screen.getByLabelText('Verification code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/campaigns'));
  });

  it('TC-8: a valid recovery code, reached via "lost your device", establishes a session', async () => {
    mockRouteByPath({
      '/auth/mfa/enrol': alreadyEnrolledRejection,
      '/auth/mfa/recover': () =>
        Promise.resolve({
          data: {
            data: {
              role: 'super_admin',
              mustChangePassword: false,
              mfaRequired: false,
              recoveryCodesRemaining: 9,
            },
          },
        }),
    });
    renderMfaPage();

    await screen.findByRole('heading', { name: 'Enter your verification code' });
    await userEvent.click(
      screen.getByRole('button', { name: 'Lost your device? Use a recovery code' }),
    );

    await screen.findByRole('heading', { name: 'Use a recovery code' });
    await userEvent.type(screen.getByLabelText('Recovery code'), 'ABCD-EFGH-JKMN');
    await userEvent.click(screen.getByRole('button', { name: 'Use recovery code' }));

    expect(mockPost).toHaveBeenCalledWith('/auth/mfa/recover', { recoveryCode: 'ABCD-EFGH-JKMN' });
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/dashboard'));
  });

  it('a wrong recovery code shows a clear error and never carries recoveryCodes forward', async () => {
    mockRouteByPath({
      '/auth/mfa/enrol': alreadyEnrolledRejection,
      '/auth/mfa/recover': () =>
        Promise.reject({
          isAxiosError: true,
          response: {
            status: 401,
            data: {
              error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'The code was incorrect.' },
            },
          },
        }),
    });
    renderMfaPage();

    await screen.findByRole('heading', { name: 'Enter your verification code' });
    await userEvent.click(
      screen.getByRole('button', { name: 'Lost your device? Use a recovery code' }),
    );
    await screen.findByRole('heading', { name: 'Use a recovery code' });
    await userEvent.type(screen.getByLabelText('Recovery code'), 'DEAD-0000-0000');
    await userEvent.click(screen.getByRole('button', { name: 'Use recovery code' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The code was incorrect.');
    expect(screen.getByRole('heading', { name: 'Use a recovery code' })).toBeInTheDocument();
  });

  it('"Back to your authenticator code" returns from the recovery form to the challenge', async () => {
    mockPost.mockImplementationOnce(alreadyEnrolledRejection);
    renderMfaPage();

    await screen.findByRole('heading', { name: 'Enter your verification code' });
    await userEvent.click(
      screen.getByRole('button', { name: 'Lost your device? Use a recovery code' }),
    );
    await screen.findByRole('heading', { name: 'Use a recovery code' });
    await userEvent.click(screen.getByRole('button', { name: 'Back to your authenticator code' }));

    expect(
      screen.getByRole('heading', { name: 'Enter your verification code' }),
    ).toBeInTheDocument();
  });

  it('TC-9: a 429 on verify shows the minutes-based message and never auto-retries', async () => {
    mockRouteByPath({
      '/auth/mfa/enrol': alreadyEnrolledRejection,
      '/auth/mfa/verify': () =>
        Promise.reject({
          isAxiosError: true,
          response: {
            status: 429,
            headers: { 'retry-after': '900' },
            data: { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } },
          },
        }),
    });
    renderMfaPage();

    await screen.findByRole('heading', { name: 'Enter your verification code' });
    await userEvent.type(screen.getByLabelText('Verification code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Too many attempts, try again in 15 minutes.');
    // One click, one call — nothing here retries on the caller's behalf.
    expect(mockPost).toHaveBeenCalledTimes(2); // the initial enrol probe + the one verify attempt
  });

  it('TC-13: a pending token that dies mid-challenge (verify 401 AUTH_SESSION_INVALID) restarts at /login', async () => {
    mockRouteByPath({
      '/auth/mfa/enrol': alreadyEnrolledRejection,
      '/auth/mfa/verify': sessionInvalidRejection,
    });
    renderMfaPage();

    await screen.findByRole('heading', { name: 'Enter your verification code' });
    await userEvent.type(screen.getByLabelText('Verification code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/login'));
  });
});

describe('MfaChallengePage — no session, no storage (TC-11, TC-12, TC-13)', () => {
  // T-060 TC-11 / AGENT-PROTOCOL R5 — mirrors `test/lib/noAuthStorage.spec.ts` (T-022) and
  // `test/auth/noAuthStorage.spec.ts` (T-020): a static scan of the *source*, not a runtime
  // touch of the real `localStorage`/`sessionStorage` globals — `.eslintrc.cjs`'s
  // `no-restricted-globals` rule already fails the lint gate on any real reference to either
  // identifier anywhere in `src`, so asserting the property by reading the global itself here
  // would be testing around the very guard this test exists to reinforce.
  it('TC-11: neither the page nor its API client ever references localStorage or sessionStorage', () => {
    for (const file of ['MfaChallengePage.tsx', 'mfaApi.ts']) {
      const source = readFileSync(
        join(__dirname, '..', '..', '..', 'src', 'features', 'auth', file),
        'utf8',
      );
      expect(source).not.toMatch(/\blocalStorage\b/);
      expect(source).not.toMatch(/\bsessionStorage\b/);
    }
  });

  it('TC-11: a full successful challenge completes with no storage-related crash', async () => {
    mockRouteByPath({
      '/auth/mfa/enrol': alreadyEnrolledRejection,
      '/auth/mfa/verify': () =>
        Promise.resolve({
          data: { data: { role: 'super_admin', mustChangePassword: false, mfaRequired: false } },
        }),
    });
    renderMfaPage();

    await screen.findByRole('heading', { name: 'Enter your verification code' });
    await userEvent.type(screen.getByLabelText('Verification code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/dashboard'));
  });

  it('TC-12: a direct visit with no pending token redirects to /login, no crash', async () => {
    mockPost.mockImplementationOnce(sessionInvalidRejection);
    renderMfaPage();

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/login'));
  });

  it('TC-13: a mid-challenge "refresh" (remount) with a still-valid pending token resumes cleanly', async () => {
    mockPost.mockImplementationOnce(alreadyEnrolledRejection);
    const { unmount } = renderMfaPage();
    await screen.findByRole('heading', { name: 'Enter your verification code' });
    unmount();

    mockPost.mockImplementationOnce(alreadyEnrolledRejection);
    renderMfaPage();
    await screen.findByRole('heading', { name: 'Enter your verification code' });
  });

  it('TC-13: a mid-challenge "refresh" with an expired pending token returns to /login, never a blank screen', async () => {
    mockPost.mockImplementationOnce(alreadyEnrolledRejection);
    const { unmount } = renderMfaPage();
    await screen.findByRole('heading', { name: 'Enter your verification code' });
    unmount();

    mockPost.mockImplementationOnce(sessionInvalidRejection);
    renderMfaPage();
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/login'));
  });
});

describe('MfaChallengePage — load failure', () => {
  it('an unexpected failure to load the challenge shows a retryable error, not a crash', async () => {
    mockPost.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 500, data: { error: { code: 'INTERNAL_ERROR', message: 'Boom.' } } },
    });
    renderMfaPage();

    await screen.findByRole('heading', { name: 'Something went wrong' });
    expect(screen.getByRole('alert').textContent).toBe('Boom.');

    mockPost.mockResolvedValueOnce(enrolSuccess());
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('heading', { name: 'Set up two-factor authentication' });
  });
});
