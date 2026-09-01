/**
 * T-006 — TC-1: the real route table, mounted inside the real shell (`Layout`: `Nav` + the SSE
 * subscription). Verifies each of the 5 routes matches a distinct placeholder (a real routing
 * assertion, not five copies of the same "Coming soon" text the T-002 scaffold used), that
 * clicking a nav pill actually navigates and updates the active pill, and that an unmatched path
 * renders none of them.
 *
 * T-007 — `/` now renders the real `DashboardPage` (router.tsx's own header explains this
 * registration-point edit), so this file's `/` expectation and its supporting mocks are updated
 * to match — `router.test.tsx` only needs to prove routing still works, not re-exercise
 * `DashboardPage`'s own content (that's `features/dashboard/DashboardPage.test.tsx`'s job), so
 * `getDashboard` is stubbed to an empty-but-valid summary here.
 *
 * T-008 — `/campaigns` and `/campaigns/:code` now render the real `CampaignsPage`/
 * `CampaignDetailPage`, so this file's expectations for those two paths are updated the same way:
 * `getCampaigns`/`getCampaign` are stubbed to a minimal real-shaped response and the `:code` path
 * uses a real demo campaign code so the page actually renders its hero (a routing test has no
 * reason to exercise the not-found path — that's this feature's own `CampaignDetailPage.test.tsx`).
 *
 * T-010 — `/activity` now renders the real `ActivitySimulatorPage`, so `getActivities` is stubbed
 * to an empty history the same "just enough to resolve, not a content test" way as every other
 * page's own stub above (`ActivitySimulatorPage.test.tsx` owns that page's real content).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as apiClient from '../lib/apiClient';
import { ThemeProvider } from './ThemeProvider';
import { CustomerProvider } from './CustomerProvider';
import { routes } from './router';

class NoopEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: NoopEventSource[] = [];

  readonly url: string;
  readyState = NoopEventSource.OPEN;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    NoopEventSource.instances.push(this);
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

function renderAt(initialPath: string) {
  const queryClient = new QueryClient();
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <CustomerProvider>
          <RouterProvider router={router} />
        </CustomerProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe('router', () => {
  beforeEach(() => {
    NoopEventSource.instances = [];
    vi.spyOn(apiClient, 'getCustomers').mockResolvedValue([
      { id: 'priya-shah', displayName: 'Priya Shah', avatarInitials: 'PS' },
      { id: 'marcus-tan', displayName: 'Marcus Tan', avatarInitials: 'MT' },
    ]);
    // T-007 — `/` now renders `DashboardPage`, which needs this to resolve before it has any
    // content to show; empty-but-valid so this file stays a routing test, not a dashboard test.
    vi.spyOn(apiClient, 'getDashboard').mockResolvedValue({
      customerId: 'priya-shah',
      activeCampaigns: [],
      rewardCounts: { total: 0, unused: 0, used: 0 },
      trackerProgress: [],
      expiringSoon: [],
    });
    vi.spyOn(apiClient, 'getCampaigns').mockResolvedValue([]);
    vi.spyOn(apiClient, 'getCampaign').mockResolvedValue({
      campaignId: 1,
      campaignCode: 'SUMMER_CASHBACK_SPRINT',
      name: 'Summer Cashback Sprint',
      description: null,
      startDate: '2026-06-01',
      endDate: '2026-08-31',
      status: 'active',
      campaignRewards: [],
      trackers: [],
    });
    vi.spyOn(apiClient, 'getActivities').mockResolvedValue([]);
    vi.stubGlobal('EventSource', NoopEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['/', /Welcome back/],
    ['/campaigns', 'Campaigns'],
    ['/campaigns/SUMMER_CASHBACK_SPRINT', 'Summer Cashback Sprint'],
    ['/rewards', 'My Rewards'],
    ['/activity', 'Activity Simulator'],
  ])('renders the shell + real/placeholder content for %s', async (path, expectedHeading) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { name: expectedHeading })).toBeInTheDocument();
    // The shell itself is present on every route, not just the matched page.
    expect(screen.getByRole('link', { name: 'Perks home' })).toBeInTheDocument();
  });

  it('renders none of the known placeholders for an unmatched path', async () => {
    renderAt('/nope');
    await waitFor(() => expect(screen.queryByText(/Welcome back/)).not.toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Campaigns' })).not.toBeInTheDocument();
  });

  it('clicking a nav pill navigates and updates the active pill (TC-1)', async () => {
    const user = userEvent.setup();
    renderAt('/');

    await screen.findByRole('heading', { name: /Welcome back/ });

    await user.click(screen.getAllByRole('link', { name: 'Campaigns' })[0]);

    expect(await screen.findByRole('heading', { name: 'Campaigns' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Campaigns' })[0]).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('opens the SSE connection for the default (first) customer once the roster loads', async () => {
    renderAt('/');

    await waitFor(() => expect(NoopEventSource.instances).toHaveLength(1));
    expect(NoopEventSource.instances[0].url).toBe('/api/events?customerId=priya-shah');
  });
});
