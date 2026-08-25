/**
 * T-049 TC-20 — *"checker opens the route → Forbidden page"*.
 *
 * Driven through the **real** route table (`buildRouteObjects()`), not through a hand-mounted
 * `<RequirePermission>`, because what TC-20 is actually about is the row this task added to
 * `PROTECTED_ROUTE_SPECS`: `/campaigns/assistant` guarded by `campaign`/`create`, the same pair
 * `agent.controller.ts` enforces server-side. A test that mounted the guard directly would still
 * pass if the row were wrong.
 *
 * The guard is UX only — `@Roles('maker')` plus `@RequirePermission('campaign','create')` on the
 * controller is what actually refuses a checker (T-048 verification step 7 evidenced the 403). What
 * this proves is that the SPA does not show a door the server would slam.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import type { Bootstrap } from '@reward-portal/shared';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));

// The same axios stub `test/auth/router.spec.tsx` uses — `lib/apiClient.ts` builds its singleton
// at import time and registers interceptors on the result, so the stub has to be structurally
// complete or the import throws before any test runs.
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

import { PROTECTED_ROUTE_SPECS, buildRouteObjects } from '../../../src/app/router';

/** T004_001 grants a checker `view`/`approve`/`reject`/`return` on `campaign` — never `create`. */
const checkerBootstrap: Bootstrap = {
  user: { id: 3, displayName: 'Cai Checker', role: 'checker', locale: 'en', timezone: null },
  scope: { countryId: 1, tenantId: 1, merchantId: null },
  nav: [],
  permissions: { campaign: ['view'], approval: ['view', 'approve', 'reject'] },
  widgets: [],
  messages: {},
};

const makerBootstrap: Bootstrap = {
  user: { id: 2, displayName: 'Mo Maker', role: 'maker', locale: 'en', timezone: null },
  scope: { countryId: 1, tenantId: 1, merchantId: null },
  nav: [],
  permissions: { campaign: ['view', 'create', 'update', 'submit'] },
  widgets: [],
  messages: {},
};

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(buildRouteObjects(), {
    initialEntries: [path],
    future: { v7_relativeSplatPath: true },
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

describe('TC-20 — /campaigns/assistant is behind campaign:create', () => {
  it('is registered with the same entity/action the server enforces', () => {
    const spec = PROTECTED_ROUTE_SPECS.find((row) => row.path === '/campaigns/assistant');
    expect(spec).toBeDefined();
    expect(spec?.entity).toBe('campaign');
    expect(spec?.action).toBe('create');
  });

  it('a checker gets the Forbidden page, and the screen never mounts', async () => {
    mockGet.mockResolvedValue({ data: { data: checkerBootstrap } });

    renderAt('/campaigns/assistant');

    expect(
      await screen.findByRole('heading', { name: "You don't have access to this page" }),
    ).toBeInTheDocument();
    // The page behind the guard never rendered, so it never called the agent API.
    expect(mockPost).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Create with AI' })).not.toBeInTheDocument();
  });

  it('a maker reaches the screen', async () => {
    mockGet.mockResolvedValue({ data: { data: makerBootstrap } });
    mockPost.mockResolvedValue({ data: { data: [] } });

    renderAt('/campaigns/assistant');

    expect(await screen.findByRole('heading', { name: 'Create with AI' })).toBeInTheDocument();
  });

  it('"assistant" is never read as a campaign id — the static segment wins', async () => {
    mockGet.mockResolvedValue({ data: { data: makerBootstrap } });
    mockPost.mockResolvedValue({ data: { data: [] } });

    const router = renderAt('/campaigns/assistant');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Create with AI' })).toBeInTheDocument();
    });
    expect(router.state.matches.at(-1)?.route.path).toBe('campaigns/assistant');
  });
});
