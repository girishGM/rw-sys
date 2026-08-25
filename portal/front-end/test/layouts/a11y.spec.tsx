/**
 * T-023 — TC-19 ("axe scan of the shell: zero violations"). Same approach `features/trace/
 * a11y.test.tsx` (T-045) already established for this workspace: `axe-core` is present on disk
 * (a transitive dependency hoisted by T-021's own `npm install`, pinned as an explicit
 * `devDependency` since T-045), so this runs the real engine directly against jsdom-rendered
 * output rather than through Storybook/a real browser. `color-contrast`/`color-contrast-enhanced`
 * are excluded because jsdom has no real layout/paint engine to evaluate them honestly — every
 * other rule in axe-core's default set (ARIA correctness, landmark/heading structure,
 * name/role/value, duplicate ids, label association, and more) runs for real. Contrast for the
 * shared token palette is already covered by `test/components/tokenContrast.spec.ts` (T-021).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as axe from 'axe-core';
import { BootstrapContext } from '../../src/auth/useBootstrap';
import { AppShell } from '../../src/layouts/AppShell';
import { NAV_WITH_CHILDREN, SUPER_ADMIN_WIDGETS, makeBootstrapValue } from './fixtures';
import { DashboardPage } from '../../src/features/dashboard/DashboardPage';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));

vi.mock('../../src/lib/apiClient', () => ({ api: { get: mockGet, post: mockPost } }));
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { default: { ...actual.default, create: () => ({ post: mockPost }) } };
});

const JSDOM_LAYOUT_DEPENDENT_RULES = ['color-contrast', 'color-contrast-enhanced'];

/** Shape-appropriate `/dashboard/widgets/:key` response per key prefix — a `kpi_*` and a
 * `chart_*`/`list_*` widget expect different payload shapes (`features/dashboard/widgets/types.ts`). */
function widgetResponseFor(widgetKey: string): unknown {
  if (widgetKey.startsWith('chart_')) {
    return {
      series: [
        { label: 'Malaysia', value: 4 },
        { label: 'Singapore', value: 2 },
      ],
    };
  }
  if (widgetKey.startsWith('list_')) {
    return { items: [{ id: 1, primary: 'Something happened', secondary: 'Just now' }] };
  }
  return { value: 12 };
}

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

function renderShell(initialPath = '/dashboard') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>
        <BootstrapContext.Provider
          value={makeBootstrapValue({ nav: NAV_WITH_CHILDREN, widgets: SUPER_ADMIN_WIDGETS })}
        >
          <Routes>
            <Route
              path="*"
              element={
                <AppShell>
                  <DashboardPage />
                </AppShell>
              }
            />
          </Routes>
        </BootstrapContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// `cleanup()` before the mocks are (re)armed — see `test/dashboard/widgets/KpiWidget.spec.tsx`'s
// identical comment for the reproducible Vitest/TanStack-Query timing interaction this avoids.
beforeEach(() => {
  cleanup();
  mockGet.mockReset();
  mockPost.mockReset();
});

describe('TC-19 — axe-core scan of the shell, zero violations', () => {
  it('desktop shell with a populated dashboard', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === '/notifications/unread-count')
        return Promise.resolve({ data: { data: { count: 3 } } });
      const match = /^\/dashboard\/widgets\/(.+)$/.exec(path);
      if (match) return Promise.resolve({ data: { data: widgetResponseFor(match[1]) } });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });

    const { container } = renderShell();
    await waitFor(() => expect(screen.getAllByText('12').length).toBeGreaterThan(0));
    await scan(container, 'Desktop shell, populated dashboard');
  });

  it('the mobile drawer open state', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === '/notifications/unread-count')
        return Promise.resolve({ data: { data: { count: 0 } } });
      const match = /^\/dashboard\/widgets\/(.+)$/.exec(path);
      if (match) return Promise.resolve({ data: { data: widgetResponseFor(match[1]) } });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const user = userEvent.setup();
    const { container } = renderShell();

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    await screen.findByRole('dialog', { name: 'Menu' });
    await scan(container, 'Mobile drawer open');
  });

  it('the empty dashboard state (no widgets configured)', async () => {
    mockGet.mockResolvedValue({ data: { data: { count: 0 } } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <BootstrapContext.Provider
            value={makeBootstrapValue({ nav: NAV_WITH_CHILDREN, widgets: [] })}
          >
            <Routes>
              <Route
                path="*"
                element={
                  <AppShell>
                    <DashboardPage />
                  </AppShell>
                }
              />
            </Routes>
          </BootstrapContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText('Nothing to show yet');
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/notifications/unread-count'));
    await scan(container, 'Empty dashboard');
  });

  it('a widget in its error state does not break the scan', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === '/notifications/unread-count')
        return Promise.resolve({ data: { data: { count: 0 } } });
      return Promise.reject({ isAxiosError: true, response: { status: 500 }, message: 'boom' });
    });
    const { container } = renderShell();
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    await scan(container, 'Widget error state');
  });
});
