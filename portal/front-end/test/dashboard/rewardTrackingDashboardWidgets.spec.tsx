/**
 * T-INT-031 — TC-3/TC-4, exercised through the real `DashboardPage` + `WIDGET_REGISTRY` (not a
 * mock of either), so the actual lookup-by-`widget_key` mechanism `DashboardPage.tsx` implements
 * is what's under test, not a restatement of it. `widgetRegistry.spec.ts`'s own "genuinely
 * absent" case and `DashboardPage.spec.tsx`'s own TC-10 already prove this mechanism generically;
 * this file closes the same two test cases specifically for this task's two new keys, per the
 * task file's own DoD ("TC-1 through TC-6 pass").
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { BootstrapContext } from '../../src/auth/useBootstrap';
import { DashboardPage } from '../../src/features/dashboard/DashboardPage';
import { makeBootstrapValue } from '../layouts/fixtures';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('../../src/lib/apiClient', () => ({ api: { get: mockGet } }));

function renderDashboard(
  widgets: { key: string; label: string; config: Record<string, unknown> }[],
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BootstrapContext.Provider value={makeBootstrapValue({ widgets })}>
          <DashboardPage />
        </BootstrapContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  mockGet.mockReset();
});

describe('TC-3: a role with no grant for the new widget key', () => {
  it('does not render the reward-tracking widgets at all — not a blank/error tile', () => {
    mockGet.mockResolvedValue({ data: { data: { alerts: [] } } });
    // A bootstrap payload for a role whose seeded `role_dashboard_widgets` rows never included
    // either new key (e.g. a role T174_001 was never run for) — the exact shape `useBootstrap()`
    // would hand `DashboardPage` in that case: the two keys are simply absent from `widgets`.
    renderDashboard([{ key: 'kpi_countries', label: 'Countries', config: { type: 'kpi' } }]);

    expect(screen.getByText('Countries')).toBeInTheDocument();
    expect(screen.queryByText('Reward Budget Alerts')).not.toBeInTheDocument();
    expect(screen.queryByText('Campaign Reward Progress')).not.toBeInTheDocument();
    // No network call for either widget's data — proof this is "never rendered", not "rendered
    // then hidden".
    expect(mockGet).not.toHaveBeenCalledWith('/dashboard/reward-tracking/alerts');
  });
});

describe('TC-4: widgetRegistry.ts missing-key fallback, unaffected by this task', () => {
  it("still renders null for an unknown key alongside this task's own two real ones", async () => {
    mockGet.mockResolvedValue({ data: { data: { alerts: [] } } });
    renderDashboard([
      { key: 'kpi_reward_tracking_alerts', label: 'Reward Budget Alerts', config: {} },
      { key: 'totally_unknown_widget', label: 'Mystery', config: {} },
      { key: 'list_campaign_reward_progress', label: 'Campaign Reward Progress', config: {} },
    ]);

    await waitFor(() => expect(screen.getAllByText('0').length).toBeGreaterThan(0));
    expect(screen.getByRole('heading', { name: 'Campaign Reward Progress' })).toBeInTheDocument();
    expect(screen.queryByText('Mystery')).not.toBeInTheDocument();
  });
});
