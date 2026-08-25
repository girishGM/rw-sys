/**
 * T-083 — regression coverage for "no route-level code splitting: entire SPA ships as one
 * static bundle" (T-053 TC-13/TC-14: the Access Control screen, and every chart-bearing route,
 * must load as a separate chunk, not the initial bundle).
 *
 * `npm run build` (verified manually, see the completion report) is the direct proof that a
 * separate `dist/assets/*.js` chunk exists for `features/access-control` and never appears in
 * the main entry chunk's sources. That is a build-output property Vitest cannot see. What this
 * file proves instead, at the unit level, is the actual mechanism that build-time splitting
 * *depends on*: `router.tsx` must reach `AccessControlPage` through a genuine dynamic
 * `import()` (`React.lazy`), not a top-level static one — because only a dynamic import can be
 * deferred, held pending, and observed mid-flight the way this test does.
 *
 * This is deliberately not a check of `router.tsx`'s source text (e.g. grepping for
 * `React.lazy`) — per AGENT-PROTOCOL §3's "assert the observable property, not the
 * implementation string", a string match would only fail if someone changed the literal
 * spelling, not if the import stopped being genuinely deferred. Mocking the module path with a
 * promise this test controls, and asserting the fallback renders *before* that promise settles
 * and the real page renders *after*, is something only a real dynamic import can pass: a static
 * top-level import would need this same mocked module to resolve before `router.tsx` itself —
 * and therefore this whole test file — could finish loading, which is exactly the failure mode
 * proven below by temporarily reverting the fix (see the completion report for that run).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { superAdminBootstrap } from './fixtures';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));

// Same structurally-complete axios stub every router-level test in this directory uses —
// `lib/apiClient.ts` builds its singleton at import time and registers interceptors on the
// result, so the mock has to look complete enough or the import throws before this file's
// tests even run.
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

// The mock this test is actually about: a promise standing in for `features/access-control`'s
// module namespace, that only *this test* decides when to settle. `router.tsx`'s own
// `import('../features/access-control')` and this spec's `import('../../src/features/access-
// control')` resolve to the same module id, so mocking one intercepts the other too.
const { accessControlModulePromise, resolveAccessControlModule } = vi.hoisted(() => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { accessControlModulePromise: promise, resolveAccessControlModule: resolve };
});

vi.mock('../../src/features/access-control', () => accessControlModulePromise);

import { buildRouteObjects } from '../../src/app/router';

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

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('T-083 TC-2/TC-3: /admin/access-control loads through a real dynamic import', () => {
  it(
    'renders the chunk-loading fallback while the module is still in flight, then the real ' +
      'page once it resolves — proving the import is deferred, not bundled statically',
    async () => {
      mockGet.mockResolvedValue({ data: { data: superAdminBootstrap } });

      renderRouterAt(['/admin/access-control']);

      // The shell (sidebar/top bar) is already up — bootstrap resolved — but the
      // Access Control screen's own module has not "arrived" yet.
      await waitFor(() =>
        expect(screen.getByRole('status', { name: 'Loading page' })).toBeInTheDocument(),
      );
      expect(screen.queryByRole('heading', { name: 'Access Control' })).not.toBeInTheDocument();

      // "Deliver" the chunk.
      resolveAccessControlModule({
        AccessControlPage: () => <h1>Access Control</h1>,
      });

      await waitFor(() =>
        expect(screen.getByRole('heading', { name: 'Access Control' })).toBeInTheDocument(),
      );
      expect(screen.queryByRole('status', { name: 'Loading page' })).not.toBeInTheDocument();
    },
    10_000,
  );
});
