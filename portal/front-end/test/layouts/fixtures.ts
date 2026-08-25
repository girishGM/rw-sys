import type { BootstrapNavItem, BootstrapWidget } from '@reward-portal/shared';
import type { BootstrapContextValue } from '../../src/auth/useBootstrap';

/** A `BootstrapContextValue` a test can drop straight into `<BootstrapContext.Provider>`,
 * bypassing the network entirely — the same pattern `features/trace/a11y.test.tsx` (T-045)
 * uses. Every field defaults to the "nothing loaded yet" shape; pass overrides for the rest. */
export function makeBootstrapValue(
  overrides: Partial<BootstrapContextValue> = {},
): BootstrapContextValue {
  return {
    user: {
      id: 1,
      displayName: 'Ada SuperAdmin',
      role: 'super_admin',
      locale: 'en',
      timezone: null,
    },
    scope: { countryId: null, tenantId: null, merchantId: null },
    nav: [],
    permissions: {},
    widgets: [],
    messages: {},
    isLoading: false,
    isError: false,
    isUnauthorized: false,
    hasPermission: () => true,
    refetch: () => undefined,
    ...overrides,
  };
}

export const THREE_ITEM_NAV: BootstrapNavItem[] = [
  { key: 'dashboard', label: 'Dashboard', icon: null, path: '/dashboard', children: [] },
  { key: 'countries', label: 'Countries', icon: null, path: '/countries', children: [] },
  { key: 'rules', label: 'Rules', icon: null, path: '/rules', children: [] },
];

export const NAV_WITH_CHILDREN: BootstrapNavItem[] = [
  { key: 'dashboard', label: 'Dashboard', icon: null, path: '/dashboard', children: [] },
  {
    key: 'campaigns',
    label: 'Campaigns',
    icon: null,
    path: '/campaigns',
    children: [
      {
        key: 'campaign_new',
        label: 'Create Campaign',
        icon: null,
        path: '/campaigns/new',
        children: [],
      },
      {
        key: 'campaign_journey',
        label: 'Journey Builder',
        icon: null,
        path: '/campaigns/new/journey',
        children: [],
      },
    ],
  },
];

export const SUPER_ADMIN_WIDGETS: BootstrapWidget[] = [
  { key: 'kpi_countries', label: 'Countries', config: { type: 'kpi' } },
  { key: 'kpi_tenants', label: 'Tenants', config: { type: 'kpi' } },
  { key: 'kpi_active_campaigns', label: 'Active Campaigns', config: { type: 'kpi' } },
  { key: 'chart_campaigns_by_country', label: 'Campaigns by Country', config: { type: 'chart' } },
  { key: 'list_recent_admin_activity', label: 'Recent Admin Activity', config: { type: 'list' } },
];

export const MAKER_WIDGETS: BootstrapWidget[] = [
  { key: 'kpi_my_drafts', label: 'My Drafts', config: { type: 'kpi' } },
  { key: 'kpi_my_pending', label: 'My Pending', config: { type: 'kpi' } },
  { key: 'kpi_my_rejected', label: 'My Rejected', config: { type: 'kpi' } },
  { key: 'list_my_campaigns', label: 'My Campaigns', config: { type: 'list' } },
  { key: 'list_returned_for_rework', label: 'Returned for Rework', config: { type: 'list' } },
];

export const MERCHANT_WIDGETS: BootstrapWidget[] = [
  { key: 'kpi_active_campaigns', label: 'Active Campaigns', config: { type: 'kpi' } },
  { key: 'kpi_my_activities', label: 'My Activities', config: { type: 'kpi' } },
  { key: 'chart_campaign_performance', label: 'Campaign Performance', config: { type: 'chart' } },
];

export function makeAxiosError(status: number): {
  isAxiosError: true;
  response: { status: number; headers?: Record<string, string> };
  message: string;
} {
  return {
    isAxiosError: true,
    response: { status },
    message: `Request failed with status code ${status}`,
  };
}

export const noop = (): void => {
  /* intentionally empty */
};
