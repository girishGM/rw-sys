/**
 * T-033 — TC-25 ("axe scan of the screen: zero violations; drag-reorder has a keyboard
 * alternative"). Real `axe-core` scans (the same engine `npm run test:a11y` drives — see
 * `test/trace/a11y.test.tsx`'s header for the full precedent and the one honest caveat every
 * jsdom-based axe run carries: `color-contrast` needs real layout/paint jsdom cannot provide, so
 * it is disabled here exactly as that file disables it, and every other default rule stays on.
 *
 * The keyboard-alternative half of TC-25 is proven separately, directly: `NavConfigEditor.tsx`
 * and `WidgetsConfigEditor.tsx` deliberately have **no** drag-and-drop mechanism at all — Up/Down
 * `<button>`s are the *only* reorder control, so "does a keyboard alternative exist" is not a
 * question of falling back to one; it is the only path there is (see those two files' own
 * headers for why). The reorder button click tests in `NavConfigEditor.test.tsx`/
 * `WidgetsConfigEditor.test.tsx` already exercise this control end-to-end via
 * `@testing-library/user-event`, which drives real DOM events a keyboard `Enter`/`Space` on a
 * focused `<button>` would also dispatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as axe from 'axe-core';
import type {
  EntityCatalogueEntry,
  NavConfigResponse,
  PermissionsResponse,
  PreviewResponse,
  RoleSummary,
  WidgetConfigResponse,
} from '@reward-portal/shared';

const {
  mockUseRolesQuery,
  mockUseEntitiesQuery,
  mockUseNavQuery,
  mockUsePutNavMutation,
  mockUseReorderNavMutation,
  mockUseWidgetsQuery,
  mockUsePutWidgetsMutation,
  mockUseReorderWidgetsMutation,
  mockUsePermissionsQuery,
  mockUsePutPermissionsMutation,
  mockUsePreviewMutation,
} = vi.hoisted(() => ({
  mockUseRolesQuery: vi.fn(),
  mockUseEntitiesQuery: vi.fn(),
  mockUseNavQuery: vi.fn(),
  mockUsePutNavMutation: vi.fn(),
  mockUseReorderNavMutation: vi.fn(),
  mockUseWidgetsQuery: vi.fn(),
  mockUsePutWidgetsMutation: vi.fn(),
  mockUseReorderWidgetsMutation: vi.fn(),
  mockUsePermissionsQuery: vi.fn(),
  mockUsePutPermissionsMutation: vi.fn(),
  mockUsePreviewMutation: vi.fn(),
}));

vi.mock('./api', () => ({
  useRolesQuery: mockUseRolesQuery,
  useEntitiesQuery: mockUseEntitiesQuery,
  useNavQuery: mockUseNavQuery,
  usePutNavMutation: mockUsePutNavMutation,
  useReorderNavMutation: mockUseReorderNavMutation,
  useWidgetsQuery: mockUseWidgetsQuery,
  usePutWidgetsMutation: mockUsePutWidgetsMutation,
  useReorderWidgetsMutation: mockUseReorderWidgetsMutation,
  usePermissionsQuery: mockUsePermissionsQuery,
  usePutPermissionsMutation: mockUsePutPermissionsMutation,
  usePreviewMutation: mockUsePreviewMutation,
}));

import { AccessControlPage } from './AccessControlPage';

const JSDOM_LAYOUT_DEPENDENT_RULES = ['color-contrast', 'color-contrast-enhanced'];

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

const roles: readonly RoleSummary[] = [
  { role: 'super_admin', userCount: 1 },
  { role: 'country_admin', userCount: 2 },
  { role: 'tenant_admin', userCount: 3 },
  { role: 'maker', userCount: 4 },
  { role: 'checker', userCount: 5 },
  { role: 'merchant', userCount: 6 },
];

const entities: readonly EntityCatalogueEntry[] = [
  { entity: 'campaign', actions: ['view', 'create'], protectedActions: [] },
  {
    entity: 'rule',
    actions: ['view', 'create', 'update', 'delete'],
    protectedActions: ['create', 'update', 'delete'],
  },
  {
    entity: 'access_control',
    actions: ['view', 'create', 'update', 'delete'],
    protectedActions: [],
  },
];

const nav: NavConfigResponse = {
  role: 'super_admin',
  version: 3,
  items: [
    {
      navKey: 'dashboard',
      label: 'Dashboard',
      icon: null,
      path: '/dashboard',
      parentNavKey: null,
      sortOrder: 10,
      enabled: true,
    },
    {
      navKey: 'access_control',
      label: 'Access Control',
      icon: null,
      path: '/admin/access-control',
      parentNavKey: null,
      sortOrder: 60,
      enabled: true,
    },
  ],
};

const widgets: WidgetConfigResponse = {
  role: 'super_admin',
  version: 1,
  items: [
    { widgetKey: 'kpi_countries', label: 'Countries', config: {}, sortOrder: 10, enabled: true },
  ],
};

const permissions: PermissionsResponse = {
  role: 'super_admin',
  version: 1,
  permissions: { access_control: ['view', 'update', 'create', 'delete'], user: ['create'] },
};

const previewResponse: PreviewResponse = {
  role: 'super_admin',
  nav: [{ key: 'dashboard', label: 'Dashboard', icon: null, path: '/dashboard', children: [] }],
  permissions: { access_control: ['view', 'update'] },
  widgets: [{ key: 'kpi_countries', label: 'Countries', config: {} }],
};

beforeEach(() => {
  mockUseRolesQuery.mockReset();
  mockUseEntitiesQuery.mockReset();
  mockUseNavQuery.mockReset();
  mockUsePutNavMutation.mockReset();
  mockUseReorderNavMutation.mockReset();
  mockUseWidgetsQuery.mockReset();
  mockUsePutWidgetsMutation.mockReset();
  mockUseReorderWidgetsMutation.mockReset();
  mockUsePermissionsQuery.mockReset();
  mockUsePutPermissionsMutation.mockReset();
  mockUsePreviewMutation.mockReset();

  mockUseRolesQuery.mockReturnValue({ data: roles, isLoading: false, error: null });
  mockUseEntitiesQuery.mockReturnValue({ data: entities, isLoading: false });
  mockUseNavQuery.mockReturnValue({ data: nav, isLoading: false });
  mockUsePutNavMutation.mockReturnValue({ mutate: vi.fn(), isPending: false, error: null });
  mockUseReorderNavMutation.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseWidgetsQuery.mockReturnValue({ data: widgets, isLoading: false });
  mockUsePutWidgetsMutation.mockReturnValue({ mutate: vi.fn(), isPending: false, error: null });
  mockUseReorderWidgetsMutation.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUsePermissionsQuery.mockReturnValue({ data: permissions, isLoading: false });
  mockUsePutPermissionsMutation.mockReturnValue({ mutate: vi.fn(), isPending: false, error: null });
  mockUsePreviewMutation.mockReturnValue({ mutate: vi.fn(), isPending: false, data: undefined });
});

afterEach(() => {
  cleanup();
});

describe('TC-25 — axe-core scan of the Access Control screen, zero violations', () => {
  it('the role list with the default (Navigation) section has no violations', async () => {
    const { container } = render(<AccessControlPage />);
    await screen.findByDisplayValue('Dashboard');
    await scan(container, 'Navigation section');
  });

  it('the Permissions section (locked cells included) has no violations', async () => {
    const { container } = render(<AccessControlPage />);
    await userEvent.click(screen.getByRole('tab', { name: 'Permissions' }));
    await screen.findByText('access_control');
    await scan(container, 'Permissions section');
  });

  it('the Dashboard (widgets) section has no violations', async () => {
    const { container } = render(<AccessControlPage />);
    await userEvent.click(screen.getByRole('tab', { name: 'Dashboard' }));
    await screen.findByDisplayValue('Countries');
    await scan(container, 'Dashboard section');
  });

  it('the loading state has no violations', async () => {
    mockUseRolesQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    const { container } = render(<AccessControlPage />);
    await scan(container, 'Loading state');
  });

  it('the preview modal, populated, has no violations', async () => {
    mockUsePreviewMutation.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      data: previewResponse,
    });
    const { container } = render(<AccessControlPage />);
    await userEvent.click(screen.getByRole('button', { name: /Preview/ }));
    await screen.findByText('Nothing shown here has been saved.');
    await scan(container, 'Preview modal');
  });
});
