/**
 * T-006 — the real route table (ARCHITECTURE.md §4/§6): `/`, `/campaigns`, `/campaigns/:code`,
 * `/rewards`, `/activity`, all rendered inside one shared `Layout` (`./Layout.tsx` — the app
 * shell: `Nav`, the gradient-mesh background, the live SSE subscription for the
 * currently-selected customer).
 *
 * `routes` is exported separately from `router` so `router.test.tsx` can mount the exact same
 * route tree inside a `createMemoryRouter` instead of hand-duplicating the path list (the
 * T-002/T-005 placeholder test did this — see that file's own former header). `Layout` lives in
 * its own file (not declared inline here) purely so this file's own exports stay
 * non-component-only — see `ThemeProvider.tsx`/`useTheme.ts`'s header (T-005) for the same
 * `eslint-plugin-react-refresh` `only-export-components` reasoning.
 *
 * T-007 replaced the `/` placeholder with the real `DashboardPage` — an append-only edit to this
 * registration point (`AGENT-PROTOCOL.md` R3), the same pattern T-008–T-010 followed for their
 * own routes.
 *
 * T-008 replaced `/campaigns` and `/campaigns/:code` with the real `CampaignsPage`/
 * `CampaignDetailPage` the same append-only way.
 *
 * T-009 replaced `/rewards` with the real `RewardsPage`, same append-only pattern.
 *
 * T-010 replaces `/activity` with the real `ActivitySimulatorPage`, the last of the 5 routes to
 * move off its `RoutePlaceholder` — that file (its own former header explained the
 * `only-export-components` split) is now dead code with no route left pointing at it, so this
 * edit deletes it too, the same "last real consumer replaced ⇒ delete the placeholder" precedent
 * T-006's own completion report recorded for `pages/ComingSoon.tsx`.
 */
import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { Layout } from './Layout';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { CampaignsPage } from '../features/campaigns/CampaignsPage';
import { CampaignDetailPage } from '../features/campaigns/CampaignDetailPage';
import { RewardsPage } from '../features/rewards/RewardsPage';
import { ActivitySimulatorPage } from '../features/activity-simulator/ActivitySimulatorPage';

export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { path: '/', element: <DashboardPage /> },
      { path: '/campaigns', element: <CampaignsPage /> },
      { path: '/campaigns/:code', element: <CampaignDetailPage /> },
      { path: '/rewards', element: <RewardsPage /> },
      { path: '/activity', element: <ActivitySimulatorPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
