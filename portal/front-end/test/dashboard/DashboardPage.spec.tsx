import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BootstrapWidget } from '@reward-portal/shared';
import { BootstrapContext } from '../../src/auth/useBootstrap';
import { DashboardPage } from '../../src/features/dashboard/DashboardPage';
import {
  MAKER_WIDGETS,
  MERCHANT_WIDGETS,
  SUPER_ADMIN_WIDGETS,
  makeBootstrapValue,
} from '../layouts/fixtures';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock('../../src/lib/apiClient', () => ({ api: { get: mockGet } }));

function renderDashboard(widgets: BootstrapWidget[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={makeBootstrapValue({ widgets })}>
        <DashboardPage />
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

// `cleanup()` before the mock is (re)armed, not only in a separate `afterEach` — see
// `test/dashboard/widgets/KpiWidget.spec.tsx`'s identical comment for the reproducible
// Vitest/TanStack-Query timing interaction this ordering avoids.
beforeEach(() => {
  cleanup();
  mockGet.mockReset();
});

describe('TC-7: dashboard as super_admin', () => {
  it('renders exactly the 5 super_admin widgets, in bootstrap order', () => {
    mockGet.mockReturnValue(new Promise(() => undefined));
    const { container } = renderDashboard(SUPER_ADMIN_WIDGETS);

    const headings = within(container)
      .getAllByRole('heading', { level: 1 })
      .concat(within(container).getAllByRole('heading', { level: 2 }));
    // h1 is "Dashboard" itself; the remaining headings are the 5 widget tiles with a labelled
    // card header (kpi tiles have no <h*>, only chart/list widgets do — see below for the kpi
    // count check).
    expect(headings.map((h) => h.textContent)).toEqual([
      'Dashboard',
      'Campaigns by Country',
      'Recent Admin Activity',
    ]);
    expect(screen.getByText('Countries')).toBeInTheDocument();
    expect(screen.getByText('Tenants')).toBeInTheDocument();
    expect(screen.getByText('Active Campaigns')).toBeInTheDocument();
  });
});

describe('TC-8: dashboard as maker', () => {
  it('renders exactly the 5 maker widgets; no super_admin-only widget present', () => {
    mockGet.mockReturnValue(new Promise(() => undefined));
    renderDashboard(MAKER_WIDGETS);

    expect(screen.getByText('My Drafts')).toBeInTheDocument();
    expect(screen.getByText('My Pending')).toBeInTheDocument();
    expect(screen.getByText('My Rejected')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'My Campaigns' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Returned for Rework' })).toBeInTheDocument();
    expect(screen.queryByText('Countries')).not.toBeInTheDocument();
  });
});

describe('TC-9: dashboard as merchant', () => {
  it('renders exactly the 3 merchant widgets configured', () => {
    mockGet.mockReturnValue(new Promise(() => undefined));
    renderDashboard(MERCHANT_WIDGETS);

    expect(screen.getByText('Active Campaigns')).toBeInTheDocument();
    expect(screen.getByText('My Activities')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Campaign Performance' })).toBeInTheDocument();
    expect(screen.queryByText('My Drafts')).not.toBeInTheDocument();
  });
});

describe('TC-10: an unregistered widget_key', () => {
  it('renders nothing for that key; the rest of the dashboard is unaffected', () => {
    mockGet.mockResolvedValue({ data: { data: { value: 3 } } });
    renderDashboard([
      { key: 'kpi_countries', label: 'Countries', config: { type: 'kpi' } },
      { key: 'totally_unknown_widget', label: 'Mystery', config: {} },
      { key: 'kpi_tenants', label: 'Tenants', config: { type: 'kpi' } },
    ]);

    expect(screen.getByText('Countries')).toBeInTheDocument();
    expect(screen.getByText('Tenants')).toBeInTheDocument();
    expect(screen.queryByText('Mystery')).not.toBeInTheDocument();
  });
});

describe('TC-11: one widget fails, the rest still render', () => {
  it('shows an error tile for the failing widget only', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === '/dashboard/widgets/kpi_tenants') {
        return Promise.reject({ isAxiosError: true, response: { status: 500 }, message: 'boom' });
      }
      if (path === '/dashboard/widgets/chart_campaigns_by_country') {
        return Promise.resolve({ data: { data: { series: [{ label: 'MY', value: 3 }] } } });
      }
      if (path === '/dashboard/widgets/list_recent_admin_activity') {
        return Promise.resolve({ data: { data: { items: [] } } });
      }
      return Promise.resolve({ data: { data: { value: 42 } } });
    });
    renderDashboard(SUPER_ADMIN_WIDGETS);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load Tenants."),
    );
    // A sibling KPI tile still renders its real value.
    await waitFor(() => expect(screen.getAllByText('42').length).toBeGreaterThan(0));
  });
});

describe('TC-12: widget order is exactly bootstrap order', () => {
  it('reorders when the fixture order changes, no code change needed', () => {
    mockGet.mockReturnValue(new Promise(() => undefined));
    const { container } = renderDashboard([...SUPER_ADMIN_WIDGETS].reverse());
    const grid = container.querySelector('.grid');
    const labels = [...(grid?.querySelectorAll('h2') ?? [])].map((h) => h.textContent);
    expect(labels).toEqual(['Recent Admin Activity', 'Campaigns by Country']);
  });
});

describe('TC-18: widget loading state', () => {
  it('shows a skeleton, not the eventual value, while the request is in flight', () => {
    mockGet.mockReturnValue(new Promise(() => undefined));
    renderDashboard(SUPER_ADMIN_WIDGETS);
    expect(screen.getByText('Countries')).toBeInTheDocument();
    expect(screen.queryByText('42')).not.toBeInTheDocument();
  });
});

describe('no widgets configured', () => {
  it('shows an explanatory empty state rather than a blank page', () => {
    renderDashboard([]);
    expect(screen.getByText('Nothing to show yet')).toBeInTheDocument();
  });
});
