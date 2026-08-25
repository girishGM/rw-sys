import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
  mockFetchCampaignAudit.mockResolvedValue({
    data: [campaignRow],
    meta: { page: 1, pageSize: 20, total: 1 },
  });
  mockFetchPortalAudit.mockResolvedValue({
    data: [portalRow],
    meta: { page: 1, pageSize: 20, total: 1 },
  });
});

afterEach(() => {
  cleanup();
});

describe('a non-super_admin role', () => {
  it('renders the campaign audit table directly, with no portal-log tab at all', async () => {
    renderPage('tenant_admin');
    await screen.findByText('submitted');
    expect(screen.queryByRole('tab', { name: /portal audit log/i })).not.toBeInTheDocument();
  });

  it('never calls fetchPortalAudit', async () => {
    renderPage('checker');
    await screen.findByText('submitted');
    expect(mockFetchPortalAudit).not.toHaveBeenCalled();
  });
});

describe('super_admin', () => {
  it('sees both tabs, campaign audit selected by default', async () => {
    renderPage('super_admin');
    await screen.findByText('submitted');
    expect(screen.getByRole('tab', { name: /campaign audit/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /portal audit log/i })).toBeInTheDocument();
  });

  it('switches to the portal audit tab and loads it', async () => {
    const user = userEvent.setup();
    renderPage('super_admin');
    await screen.findByText('submitted');

    await user.click(screen.getByRole('tab', { name: /portal audit log/i }));
    await screen.findByText('login_succeeded');
    expect(mockFetchPortalAudit).toHaveBeenCalled();
  });

  it('typing an event type re-queries the portal tab and resets to page 1', async () => {
    const user = userEvent.setup();
    renderPage('super_admin');
    await screen.findByText('submitted');
    await user.click(screen.getByRole('tab', { name: /portal audit log/i }));
    await screen.findByText('login_succeeded');

    await user.type(screen.getByLabelText('Event type'), 'permission_denied');

    await waitFor(() =>
      expect(mockFetchPortalAudit).toHaveBeenLastCalledWith(
        expect.objectContaining({ eventType: 'permission_denied', page: 1 }),
      ),
    );
  });

  it('changing the To date on the portal tab re-queries with the new filter', async () => {
    const user = userEvent.setup();
    renderPage('super_admin');
    await screen.findByText('submitted');
    await user.click(screen.getByRole('tab', { name: /portal audit log/i }));
    await screen.findByText('login_succeeded');

    await user.type(screen.getByLabelText('To'), '2026-06-01');
    await user.tab();

    await waitFor(() =>
      expect(mockFetchPortalAudit).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 })),
    );
  });
});

describe('filters', () => {
  it('changing the action filter re-queries with the new value and resets to page 1', async () => {
    const user = userEvent.setup();
    renderPage('tenant_admin');
    await screen.findByText('submitted');

    await user.click(screen.getByRole('combobox', { name: /action/i }));
    await user.click(screen.getByRole('option', { name: 'Approved' }));

    await waitFor(() =>
      expect(mockFetchCampaignAudit).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'approved', page: 1 }),
      ),
    );
  });
});

describe('loading and error states', () => {
  it('shows a loading state while the query is in flight', () => {
    mockFetchCampaignAudit.mockReturnValue(new Promise(() => undefined));
    renderPage('tenant_admin');
    expect(screen.getByRole('status', { name: /loading table data/i })).toBeInTheDocument();
  });

  it('shows an error state when the query fails', async () => {
    mockFetchCampaignAudit.mockRejectedValue(new Error('boom'));
    renderPage('tenant_admin');
    await screen.findByRole('alert');
  });

  it('shows the empty state when there are no rows', async () => {
    mockFetchCampaignAudit.mockResolvedValue({
      data: [],
      meta: { page: 1, pageSize: 20, total: 0 },
    });
    renderPage('tenant_admin');
    await screen.findByText('No audit rows');
  });
});

describe('pagination', () => {
  it('Next is disabled on the last page and Previous is disabled on the first', async () => {
    renderPage('tenant_admin');
    await screen.findByText('submitted');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('Next advances the page when more rows exist', async () => {
    mockFetchCampaignAudit.mockResolvedValue({
      data: [campaignRow],
      meta: { page: 1, pageSize: 20, total: 25 },
    });
    const user = userEvent.setup();
    renderPage('tenant_admin');
    await screen.findByText('submitted');

    await user.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() =>
      expect(mockFetchCampaignAudit).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })),
    );
  });
});

describe('CSV export link', () => {
  it('renders a download link pointing at the export endpoint', async () => {
    renderPage('tenant_admin');
    await screen.findByText('submitted');
    const link = screen.getByRole('link', { name: /export csv/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('/api/v1/audit/campaigns/export'));
  });
});
