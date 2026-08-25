import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { BOOTSTRAP_QUERY_KEY, useLogout } from '../../src/auth/useBootstrap';

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }));

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return {
    default: {
      ...actual.default,
      create: () => ({ post: mockPost }),
    },
  };
});

function LogoutButton() {
  const logout = useLogout();
  return (
    <button type="button" onClick={() => void logout()}>
      Logout
    </button>
  );
}

/**
 * T-064 — a data router (`createMemoryRouter`), not the plain `<MemoryRouter>` this harness used
 * before: only a data router exposes `router.state`/`router.navigate(-1)`, which is what makes
 * the push-vs-replace distinction below an observable property of the router's own history stack
 * rather than a restated implementation string (AGENT-PROTOCOL.md §3, "assert the observable
 * property"). Starts with a single entry (`initialEntries: ['/dashboard']`) deliberately — the
 * exact shape of the reproduction this task fixes: the pre-logout page was the *first* entry the
 * SPA itself ever pushed, so a `replace` on logout would leave nothing of the app's own history
 * behind it.
 */
function renderHarness(client: QueryClient) {
  const router = createMemoryRouter(
    [
      { path: '/login', element: <div>Login page</div> },
      { path: '/dashboard', element: <LogoutButton /> },
    ],
    { initialEntries: ['/dashboard'] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

function clearCsrfCookie() {
  document.cookie = 'rs_csrf=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/';
}

beforeEach(() => {
  mockPost.mockReset();
  clearCsrfCookie();
});

describe('useLogout', () => {
  it('TC-12: clears the cached bootstrap data', async () => {
    document.cookie = 'rs_csrf=tok123';
    mockPost.mockResolvedValue({});
    const client = new QueryClient();
    client.setQueryData(BOOTSTRAP_QUERY_KEY, { user: { displayName: 'Previous user' } });

    renderHarness(client);
    await userEvent.click(screen.getByRole('button', { name: 'Logout' }));

    await waitFor(() => expect(client.getQueryData(BOOTSTRAP_QUERY_KEY)).toBeUndefined());
    expect(mockPost).toHaveBeenCalledWith('/auth/logout', null, {
      headers: { 'X-CSRF-Token': 'tok123' },
    });
  });

  it('TC-13: sends the user to /login', async () => {
    mockPost.mockResolvedValue({});
    const client = new QueryClient();

    renderHarness(client);
    await userEvent.click(screen.getByRole('button', { name: 'Logout' }));

    await waitFor(() => expect(screen.getByText('Login page')).toBeInTheDocument());
  });

  it('T-064: pushes /login rather than replacing the current entry, so Back reaches the pre-logout route instead of falling off history', async () => {
    mockPost.mockResolvedValue({});
    const client = new QueryClient();

    const router = renderHarness(client);
    await userEvent.click(screen.getByRole('button', { name: 'Logout' }));
    await waitFor(() => expect(screen.getByText('Login page')).toBeInTheDocument());

    // The reproduction this fixes: `/dashboard` was the *only* prior entry. A `replace` would
    // have discarded it, leaving Back with nowhere real to go. A push keeps it — Back must reach
    // it, not stay stuck on /login or silently no-op.
    await act(async () => {
      await router.navigate(-1);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'));
  });

  it('still clears the cache and redirects even when the network call fails', async () => {
    mockPost.mockRejectedValue(new Error('offline'));
    const client = new QueryClient();
    client.setQueryData(BOOTSTRAP_QUERY_KEY, { user: { displayName: 'Previous user' } });

    renderHarness(client);
    await userEvent.click(screen.getByRole('button', { name: 'Logout' }));

    await waitFor(() => expect(screen.getByText('Login page')).toBeInTheDocument());
    expect(client.getQueryData(BOOTSTRAP_QUERY_KEY)).toBeUndefined();
  });

  it('sends an empty string, not the literal word "null", when no CSRF cookie is set', async () => {
    mockPost.mockResolvedValue({});
    const client = new QueryClient();

    renderHarness(client);
    await userEvent.click(screen.getByRole('button', { name: 'Logout' }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/auth/logout', null, {
        headers: { 'X-CSRF-Token': '' },
      }),
    );
  });
});
