/**
 * T-040 — TC-22 ("axe scan of both screens"), the audit-viewer half.
 *
 * Same technique T-045's `features/trace/a11y.test.tsx` established and explains at length: a
 * genuine `axe-core` scan (the same engine `npm run test:a11y` drives via Storybook, invoked
 * directly against jsdom-rendered output here since this task's scope is
 * `front-end/src/features/audit/**`, not `.storybook/**`). `color-contrast`/
 * `color-contrast-enhanced` are excluded — jsdom has no real layout/paint engine to evaluate them
 * honestly — every other rule in axe-core's default set runs for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import * as axe from 'axe-core';
import type { Bootstrap } from '@reward-portal/shared';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';
import type { CampaignAuditRow, PortalAuditRow } from './api';

const { mockFetchCampaignAudit, mockFetchPortalAudit } = vi.hoisted(() => ({
  mockFetchCampaignAudit: vi.fn(),
  mockFetchPortalAudit: vi.fn(),
}));

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    fetchCampaignAudit: mockFetchCampaignAudit,
    fetchPortalAudit: mockFetchPortalAudit,
  };
});

import { AuditViewerPage } from './AuditViewerPage';

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

const campaignRow: CampaignAuditRow = {
  id: 1,
  tenantId: 9,
  campaignId: 55,
  entityType: 'campaign_submit',
  entityId: null,
  action: 'submitted',
  fieldChanges: {},
  performedBy: 42,
  performedAt: '2026-08-19T00:00:00.000Z',
  approvedBy: null,
  approvedAt: null,
  comment: null,
};

const portalRow: PortalAuditRow = {
  id: '1',
  eventType: 'login_succeeded',
  actorId: 42,
  actorRole: 'tenant_admin',
  targetType: null,
  targetId: null,
  countryId: 3,
  tenantId: 9,
  ipAddress: '10.0.0.4',
  detail: null,
  occurredAt: '2026-08-19T00:00:00.000Z',
};

function bootstrapValue(role: Bootstrap['user']['role']): BootstrapContextValue {
  return {
    user: { id: 1, displayName: 'Test User', role, locale: 'en', timezone: null },
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
  };
}

function renderPage(role: Bootstrap['user']['role']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(role)}>
        <AuditViewerPage />
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockFetchCampaignAudit.mockReset();
  mockFetchPortalAudit.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('TC-22 — axe-core scan, zero violations', () => {
  it('the populated campaign-audit table (non-super_admin) has no violations', async () => {
    mockFetchCampaignAudit.mockResolvedValue({
      data: [campaignRow],
      meta: { page: 1, pageSize: 20, total: 1 },
    });
    const { container } = renderPage('tenant_admin');
    await screen.findByText('submitted');
    await scan(container, 'Campaign audit — populated');
  });

  it('the empty campaign-audit state has no violations', async () => {
    mockFetchCampaignAudit.mockResolvedValue({
      data: [],
      meta: { page: 1, pageSize: 20, total: 0 },
    });
    const { container } = renderPage('checker');
    await screen.findByText('No audit rows');
    await scan(container, 'Campaign audit — empty');
  });

  it('the loading state has no violations', async () => {
    mockFetchCampaignAudit.mockReturnValue(new Promise(() => undefined));
    const { container } = renderPage('tenant_admin');
    await scan(container, 'Loading state');
  });

  it('the error state has no violations', async () => {
    mockFetchCampaignAudit.mockRejectedValue(new Error('boom'));
    const { container } = renderPage('tenant_admin');
    await screen.findByRole('alert');
    await scan(container, 'Error state');
  });

  it('the portal-audit tab (super_admin) has no violations', async () => {
    mockFetchCampaignAudit.mockResolvedValue({
      data: [campaignRow],
      meta: { page: 1, pageSize: 20, total: 1 },
    });
    mockFetchPortalAudit.mockResolvedValue({
      data: [portalRow],
      meta: { page: 1, pageSize: 20, total: 1 },
    });
    const user = userEvent.setup();
    const { container } = renderPage('super_admin');
    await screen.findByText('submitted');
    await user.click(screen.getByRole('tab', { name: /portal audit log/i }));
    await screen.findByText('login_succeeded');
    await scan(container, 'Portal audit tab');
  });

  it('an open filter dropdown has no violations', async () => {
    mockFetchCampaignAudit.mockResolvedValue({
      data: [campaignRow],
      meta: { page: 1, pageSize: 20, total: 1 },
    });
    const user = userEvent.setup();
    const { container } = renderPage('tenant_admin');
    await screen.findByText('submitted');
    await user.click(screen.getByRole('combobox', { name: /action/i }));
    await screen.findByRole('listbox');
    await scan(container, 'Open filter dropdown');
  });
});
