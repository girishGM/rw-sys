import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { PROTECTED_ROUTE_SPECS, buildRouteObjects } from '../../src/app/router';
import {
  makeAxiosError,
  makeAxiosErrorWithCode,
  makerBootstrap,
  superAdminBootstrap,
} from './fixtures';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));

// T-023 — `/dashboard` now renders the real `DashboardPage`, which (via `WIDGET_REGISTRY`)
// imports `lib/apiClient.ts`'s module-level `api` singleton. That module calls
// `axios.create(...)` at import time and immediately registers request/response interceptors
// on the result (`createApiClient`, `lib/apiClient.ts`), so the mocked `create()` below needs a
// structurally complete-enough stub — `interceptors.request.use` / `interceptors.response.use`
// — or the import throws before any test in this file even runs. Every fixture used here still
// carries `widgets: []` (`./fixtures.ts`), so no widget ever actually calls through `mockGet`
// for `/dashboard/widgets/*` — this is purely about not crashing at module load.
//
// T-024 — `mockPost` covers `POST /auth/login` (`LoginPage`, via the shared `api` client and
// `features/auth/api.ts`) alongside the pre-existing `mockGet` for `/me/bootstrap`.
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

function renderRouterAt(initialEntries: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  const router = createMemoryRouter(buildRouteObjects(), {
    initialEntries,
    future: { v7_relativeSplatPath: true },
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

/** A login response body for a session that does not require any further step (T-024). */
function loginResponse(role: string) {
  return { data: { data: { role, mustChangePassword: false, mfaRequired: false } } };
}

async function submitLoginForm() {
  await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
  await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery staple 1!');
  await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
}

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('public routes render without ever touching the bootstrap call', () => {
  it('/forgot-password renders the real screen', () => {
    renderRouterAt(['/forgot-password']);
    expect(screen.getByRole('heading', { name: 'Forgot your password?' })).toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('/reset-password renders the real screen', () => {
    renderRouterAt(['/reset-password']);
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('/login renders the real screen', () => {
    renderRouterAt(['/login']);
    expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
  });

  // T-060 — registered alongside `/login` (router.tsx, append-only). Never touches
  // `/me/bootstrap` either: its only credential is the half-authenticated `__Host-rs_mfa`
  // pending cookie, not a session.
  it('/mfa-challenge renders the real screen', async () => {
    mockPost.mockResolvedValue({
      data: {
        data: {
          secret: 'ABCD1234EFGH5678',
          otpauthUri: 'otpauth://totp/Reward%20Portal:a@b.com?secret=ABCD1234EFGH5678',
          issuer: 'Reward Portal',
          account: 'a@b.com',
          algorithm: 'SHA1',
          digits: 6,
          periodSeconds: 30,
        },
      },
    });
    renderRouterAt(['/mfa-challenge']);
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Set up two-factor authentication' }),
      ).toBeInTheDocument(),
    );
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe('TC-4: every protected route redirects to /login when there is no session', () => {
  it.each(PROTECTED_ROUTE_SPECS.map((spec) => [spec.testPath ?? spec.path, spec.label] as const))(
    '%s redirects to /login',
    async (path) => {
      mockGet.mockRejectedValue(makeAxiosError(401));
      const router = renderRouterAt([path]);
      await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
      const params = new URLSearchParams(router.state.location.search);
      expect(params.get('next')).toBe(path);
    },
  );
});

describe('TC-2: direct navigation to a protected URL with no session', () => {
  it('redirects immediately and never paints the page behind the guard', async () => {
    mockGet.mockRejectedValue(makeAxiosError(401));
    const router = renderRouterAt(['/admin/access-control']);
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(screen.queryByText('Access Control')).not.toBeInTheDocument();
  });
});

describe('TC-9: bootstrap in flight', () => {
  it('shows a skeleton and renders no page content until it resolves', async () => {
    let resolveGet!: (value: unknown) => void;
    mockGet.mockReturnValue(new Promise((resolve) => (resolveGet = resolve)));
    renderRouterAt(['/dashboard']);

    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();

    resolveGet({ data: { data: superAdminBootstrap } });
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument());
  });
});

describe('TC-3: successful bootstrap renders the destination', () => {
  it('renders /dashboard once bootstrap resolves', async () => {
    mockGet.mockResolvedValue({ data: { data: superAdminBootstrap } });
    renderRouterAt(['/dashboard']);
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument());
  });
});

describe('TC-8: a role without the required permission', () => {
  it('sees Forbidden instead of the guarded page', async () => {
    mockGet.mockResolvedValue({ data: { data: makerBootstrap } });
    renderRouterAt(['/admin/access-control']);
    await waitFor(() => expect(screen.getByText(/don't have access/i)).toBeInTheDocument());
    expect(screen.queryByText('Access Control')).not.toBeInTheDocument();
  });
});

describe('TC-11: bootstrap failure', () => {
  it('shows a retryable error page, and Retry re-issues the request', async () => {
    mockGet.mockRejectedValue(makeAxiosError(500));
    renderRouterAt(['/dashboard']);
    await waitFor(() => expect(screen.getByText('Something went wrong')).toBeInTheDocument());
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();

    mockGet.mockResolvedValue({ data: { data: superAdminBootstrap } });
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument());
  });
});

describe('TC-14: an unknown path', () => {
  it('renders NotFound inside the guarded layout for an authenticated user', async () => {
    mockGet.mockResolvedValue({ data: { data: superAdminBootstrap } });
    renderRouterAt(['/this/route/does/not/exist']);
    await waitFor(() => expect(screen.getByText('Page not found')).toBeInTheDocument());
  });
});

describe('TC-5/6/7: the next-path redirect target, exercised through a real login', () => {
  it('TC-5: lands on a genuine in-app next path after logging in', async () => {
    mockGet.mockResolvedValue({ data: { data: makerBootstrap } });
    mockPost.mockResolvedValue(loginResponse('maker'));
    renderRouterAt(['/login?next=%2Fcampaigns']);
    await submitLoginForm();
    // `getByText` is ambiguous here — `CampaignsListPage` renders "Campaigns" twice (an `<h1>`
    // heading and a table's sr-only `<caption>`, both real, both by design). The heading is the
    // one property that actually confirms which page rendered; pre-existing flake unrelated to
    // T-064, tightened while fixing this file's own gate.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Campaigns' })).toBeInTheDocument(),
    );
    expect(mockPost).toHaveBeenCalledWith(
      '/auth/login',
      expect.objectContaining({ email: 'ada@example.com', password: expect.any(String) }),
    );
  });

  it('TC-6: ignores an absolute cross-origin next and lands on /dashboard instead', async () => {
    mockGet.mockResolvedValue({ data: { data: superAdminBootstrap } });
    mockPost.mockResolvedValue(loginResponse('super_admin'));
    renderRouterAt(['/login?next=https%3A%2F%2Fevil.com']);
    await submitLoginForm();
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument());
  });

  it('TC-7: ignores a protocol-relative next and lands on /dashboard instead', async () => {
    mockGet.mockResolvedValue({ data: { data: superAdminBootstrap } });
    mockPost.mockResolvedValue(loginResponse('super_admin'));
    renderRouterAt(['/login?next=%2F%2Fevil.com']);
    await submitLoginForm();
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument());
  });
});

describe('T-064: back button after logout never resurrects authenticated content', () => {
  it('TC-1/TC-2/TC-4: Back after logout re-checks the session and lands on /login with no authenticated flash', async () => {
    mockGet.mockResolvedValueOnce({ data: { data: superAdminBootstrap } });
    mockPost.mockResolvedValue({});
    const router = renderRouterAt(['/dashboard']);
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument());

    // The real UI path (mirrors e2e `session.spec.ts` TC-3): avatar menu -> "Log out".
    // T-129 — `screen.getByRole('button', { name: /Ada SuperAdmin/ })` replaces a bare
    // `document.querySelector('button[aria-haspopup="menu"]')` here: `TopBar` now renders a
    // second `aria-haspopup="menu"` button (the theme switcher, `ThemeSwitcher.tsx`) ahead of
    // the avatar menu in DOM order, so the old selector silently started returning the wrong
    // button. Matching on the user's own display name is unambiguous regardless of how many
    // other popover buttons `TopBar` grows in the future.
    const avatarButton = screen.getByRole('button', { name: /Ada SuperAdmin/ });
    await userEvent.click(avatarButton);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));

    // The session is genuinely gone server-side too — the next bootstrap call must 401, the same
    // way a real logged-out cookie would behave. This also proves the guard re-checks rather than
    // trusting any cached/stale bootstrap state: nothing here re-supplies `superAdminBootstrap`.
    mockGet.mockRejectedValue(makeAxiosError(401));

    await act(async () => {
      await router.navigate(-1);
    });

    // TC-4 — not even one frame of the dashboard the user just logged out of. The navigation
    // above has already settled (the guard has (re)mounted with an empty query cache and is
    // mid-flight on the 401 above), but nothing in that chain can ever have painted the old page.
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();

    // TC-2 — Back reaches a guarded route, which redirects to /login itself; never `about:blank`.
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('TC-3/TC-7: Back twice, and Forward, never show authenticated content', async () => {
    mockGet.mockResolvedValueOnce({ data: { data: superAdminBootstrap } });
    mockPost.mockResolvedValue({});
    const router = renderRouterAt(['/dashboard']);
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument());

    // T-129 — see the identical fix's comment in the test above for why this can no longer be
    // a bare `document.querySelector('button[aria-haspopup="menu"]')`.
    const avatarButton = screen.getByRole('button', { name: /Ada SuperAdmin/ });
    await userEvent.click(avatarButton);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));

    mockGet.mockRejectedValue(makeAxiosError(401));

    await act(async () => {
      await router.navigate(-1);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();

    // Back again — still no authenticated content, whatever entry this lands on.
    await act(async () => {
      await router.navigate(-1);
    });
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();

    // Forward — same guarantee.
    await act(async () => {
      await router.navigate(1);
    });
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });
});

describe('T-024: /change-password is authenticated but bypasses the nav guard chain', () => {
  it('redirects to /login when there is no session at all', async () => {
    mockGet.mockRejectedValue(makeAxiosError(401));
    const router = renderRouterAt(['/change-password']);
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  it('renders the form, with no sidebar/top-bar chrome, for a confined (403) session', async () => {
    mockGet.mockRejectedValue(makeAxiosErrorWithCode(403, 'PASSWORD_CHANGE_REQUIRED'));
    renderRouterAt(['/change-password']);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Change your password' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
    expect(screen.queryByText('Reward Portal')).not.toBeInTheDocument();
  });

  it('a confined session redirected from a different protected route lands on /change-password', async () => {
    mockGet.mockRejectedValue(makeAxiosErrorWithCode(403, 'PASSWORD_CHANGE_REQUIRED'));
    const router = renderRouterAt(['/dashboard']);
    await waitFor(() => expect(router.state.location.pathname).toBe('/change-password'));
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });
});
