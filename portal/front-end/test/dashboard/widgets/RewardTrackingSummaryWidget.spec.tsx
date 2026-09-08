import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RewardTrackingSummaryWidget } from '../../../src/features/dashboard/widgets/RewardTrackingSummaryWidget';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('../../../src/lib/apiClient', () => ({ api: { get: mockGet } }));

function renderWidget() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RewardTrackingSummaryWidget label="Reward Budget Alerts" config={{ type: 'kpi' }} />
    </QueryClientProvider>,
  );
}

// Same ordering as `KpiWidget.spec.tsx`'s identical comment: cleanup before the next mock is
// armed, avoiding the same Vitest/TanStack-Query unhandled-rejection timing interaction.
beforeEach(() => {
  cleanup();
  mockGet.mockReset();
});

describe('RewardTrackingSummaryWidget', () => {
  it('fetches the T-INT-030 proxy endpoint, not the generic per-widget-key route', async () => {
    mockGet.mockResolvedValue({ data: { data: { alerts: [] } } });
    renderWidget();
    expect(mockGet).toHaveBeenCalledWith('/dashboard/reward-tracking/alerts');
    await waitFor(() => expect(screen.getByText('0')).toBeInTheDocument());
  });

  it('TC-1: tenant_admin — renders exactly the (already tenant-scoped) alert count the server returned', async () => {
    mockGet.mockResolvedValue({
      data: {
        data: {
          alerts: [
            {
              campaignCode: 'TENANT1-CAMP',
              tenantId: 1,
              rewardCategory: 'CASHBACK',
              rewardKind: 'FIXED_AMOUNT',
              totalValue: '900.00',
              totalCount: 90,
              capMaxTotalAmount: '1000.00',
              consumptionPercent: 90,
              warnAtPercent: 80,
              warnTriggered: true,
            },
          ],
        },
      },
    });
    renderWidget();
    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    // TC-5: the alert surfaces as the KPI's own trend line — the widget adds no filtering of
    // its own on top of what the server already scoped (implementation note 3).
    expect(screen.getByText('90%')).toBeInTheDocument();
    expect(screen.getByText('TENANT1-CAMP nearest its cap')).toBeInTheDocument();
  });

  it('TC-2: super_admin — renders the broader alert set the server returns for that role', async () => {
    mockGet.mockResolvedValue({
      data: {
        data: {
          alerts: [
            {
              campaignCode: 'TENANT1-CAMP',
              tenantId: 1,
              rewardCategory: 'CASHBACK',
              rewardKind: 'FIXED_AMOUNT',
              totalValue: '900.00',
              totalCount: 90,
              capMaxTotalAmount: '1000.00',
              consumptionPercent: 90,
              warnAtPercent: 80,
              warnTriggered: true,
            },
            {
              campaignCode: 'TENANT2-CAMP',
              tenantId: 2,
              rewardCategory: 'VOUCHER',
              rewardKind: 'POINTS',
              totalValue: '480.00',
              totalCount: 48,
              capMaxTotalAmount: '500.00',
              consumptionPercent: 96,
              warnAtPercent: 85,
              warnTriggered: true,
            },
          ],
        },
      },
    });
    renderWidget();
    await waitFor(() => expect(screen.getByText('2')).toBeInTheDocument());
    // The highest-consumption alert across both tenants drives the trend line — real evidence
    // this is the unscoped, broader view TC-2 expects, not a client-side-narrowed one.
    expect(screen.getByText('96%')).toBeInTheDocument();
    expect(screen.getByText('TENANT2-CAMP nearest its cap')).toBeInTheDocument();
  });

  it('TC-6 (negative): a merchant-scoped caller only ever sees what the server already scoped to their own merchant', async () => {
    // The widget performs no id/role-based filtering of its own (implementation note 3) — this
    // test asserts the *outcome* a wrong implementation would break: given a merchant-scoped
    // response with a single alert, the widget must show exactly that one, not silently merge in
    // anything else. Cross-tenant/-merchant leakage is impossible here by construction: the
    // component has no code path that reaches for data outside what `fetchRewardTrackingAlerts`
    // resolved.
    mockGet.mockResolvedValue({
      data: {
        data: {
          alerts: [
            {
              campaignCode: 'MERCHANT-OWN-CAMP',
              tenantId: 1,
              rewardCategory: 'CASHBACK',
              rewardKind: 'FIXED_AMOUNT',
              totalValue: '82.00',
              totalCount: 8,
              capMaxTotalAmount: '100.00',
              consumptionPercent: 82,
              warnAtPercent: 80,
              warnTriggered: true,
            },
          ],
        },
      },
    });
    renderWidget();
    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    expect(screen.getByText('MERCHANT-OWN-CAMP nearest its cap')).toBeInTheDocument();
  });

  it('renders no trend line when there are no open alerts', async () => {
    mockGet.mockResolvedValue({ data: { data: { alerts: [] } } });
    renderWidget();
    await waitFor(() => expect(screen.getByText('0')).toBeInTheDocument());
    expect(screen.queryByText(/nearest its cap/)).not.toBeInTheDocument();
  });

  it('shows an error tile, not a crash, when the proxy call fails', async () => {
    mockGet.mockRejectedValue({ isAxiosError: true, response: { status: 502 }, message: 'boom' });
    renderWidget();
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load Reward Budget Alerts."),
    );
  });

  it('shows a loading placeholder, never the eventual count early', () => {
    mockGet.mockImplementation(() => new Promise(() => undefined));
    renderWidget();
    expect(screen.getByText('Reward Budget Alerts')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });
});
