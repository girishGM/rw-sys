/**
 * T-024 — TC-18 ("axe scan of all four pages, zero violations"). Same approach
 * `features/trace/a11y.test.tsx` (T-045) and `test/layouts/a11y.spec.tsx` (T-023) already
 * established for this workspace: `axe-core` is present on disk (a transitive dependency
 * hoisted by T-021's own `npm install`, already an explicit devDependency), so this runs the
 * real engine directly against jsdom-rendered output. `color-contrast`/`color-contrast-enhanced`
 * are excluded because jsdom has no real layout/paint engine to evaluate them honestly — every
 * other rule in axe-core's default set runs for real.
 */
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as axe from 'axe-core';
import { ChangePasswordPage } from '../../../src/features/auth/ChangePasswordPage';
import { ForgotPasswordPage } from '../../../src/features/auth/ForgotPasswordPage';
import { LoginPage } from '../../../src/features/auth/LoginPage';
import { ResetPasswordPage } from '../../../src/features/auth/ResetPasswordPage';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));

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

const JSDOM_LAYOUT_DEPENDENT_RULES = ['color-contrast', 'color-contrast-enhanced'];

async function scan(container: HTMLElement, label: string) {
  const results = await axe.run(container, {
    rules: Object.fromEntries(JSDOM_LAYOUT_DEPENDENT_RULES.map((id) => [id, { enabled: false }])),
  });
  const violations = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target),
  }));
  expect(violations, `${label}: axe-core violations`).toEqual([]);
}

function renderPage(ui: ReactElement, initialEntry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('TC-18 — axe-core scan of the four auth screens, zero violations', () => {
  it('LoginPage — default state', async () => {
    const { container } = renderPage(<LoginPage />, '/login');
    await scan(container, 'LoginPage — default');
  });

  it('LoginPage — session-expired notice', async () => {
    const { container } = renderPage(<LoginPage />, '/login?next=%2Fdashboard');
    await scan(container, 'LoginPage — session expired');
  });

  it('LoginPage — error state', async () => {
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
    const { container } = renderPage(<LoginPage />, '/login');
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await screen.findByRole('alert');
    await scan(container, 'LoginPage — error');
  });

  it('ForgotPasswordPage — form state', async () => {
    const { container } = renderPage(<ForgotPasswordPage />, '/forgot-password');
    await scan(container, 'ForgotPasswordPage — form');
  });

  it('ForgotPasswordPage — success state', async () => {
    mockPost.mockResolvedValue({ data: undefined });
    const { container } = renderPage(<ForgotPasswordPage />, '/forgot-password');
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    await screen.findByText("If an account exists for that email, we've sent a reset link.");
    await scan(container, 'ForgotPasswordPage — success');
  });

  it('ResetPasswordPage — form state', async () => {
    const { container } = renderPage(<ResetPasswordPage />, '/reset-password?token=tok');
    await scan(container, 'ResetPasswordPage — form');
  });

  it('ResetPasswordPage — error state', async () => {
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
    const { container } = renderPage(<ResetPasswordPage />, '/reset-password?token=tok');
    await userEvent.type(screen.getByLabelText('New password'), 'CorrectHorse1!');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'CorrectHorse1!');
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    await screen.findByRole('alert');
    await scan(container, 'ResetPasswordPage — error');
  });

  it('ChangePasswordPage — confined state', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { error: { code: 'PASSWORD_CHANGE_REQUIRED' } } },
      message: 'Request failed with status code 403',
    });
    const { container } = renderPage(<ChangePasswordPage />, '/change-password');
    await screen.findByText('Your account requires a new password before you can continue.');
    await scan(container, 'ChangePasswordPage — confined');
  });

  it('ChangePasswordPage — voluntary state, with a strength meter populated', async () => {
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
    const { container } = renderPage(<ChangePasswordPage />, '/change-password');
    await userEvent.type(screen.getByLabelText('New password'), 'partial');
    await scan(container, 'ChangePasswordPage — voluntary, meter populated');
  });
});
