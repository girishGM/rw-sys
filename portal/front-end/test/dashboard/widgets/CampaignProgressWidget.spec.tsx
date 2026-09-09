import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { CampaignProgressWidget } from '../../../src/features/dashboard/widgets/CampaignProgressWidget';

const { mockGet, mockNavigate } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockNavigate: vi.fn(),
}));
vi.mock('../../../src/lib/apiClient', () => ({ api: { get: mockGet } }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

function renderWidget() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CampaignProgressWidget label="Campaign Reward Progress" config={{ type: 'list' }} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Same ordering as every other widget spec in this folder — cleanup before the next mock is
// armed (see `KpiWidget.spec.tsx`'s identical comment for the timing interaction this avoids).
beforeEach(() => {
  cleanup();
  mockGet.mockReset();
  mockNavigate.mockReset();
});

const ONE_ALERT = {
  campaignCode: 'RAMADAN-BONUS',
  tenantId: 1,
  rewardCategory: 'CASHBACK',
  rewardKind: 'FIXED_AMOUNT' as const,
  totalValue: '950.00',
  totalCount: 95,
  capMaxTotalAmount: '1000.00',
  consumptionPercent: 95,
  warnAtPercent: 85,
  warnTriggered: true,
};

describe('CampaignProgressWidget', () => {
  it('shares the same query key/endpoint RewardTrackingSummaryWidget uses (T-INT-030 proxy)', async () => {
    mockGet.mockResolvedValue({ data: { data: { alerts: [] } } });
    renderWidget();
    expect(mockGet).toHaveBeenCalledWith('/dashboard/reward-tracking/alerts');
  });

  it('TC-5: a flagged budget/cap alert surfaces as a row, with its consumption vs. warn threshold', async () => {
    mockGet.mockResolvedValue({ data: { data: { alerts: [ONE_ALERT] } } });
    renderWidget();
    await waitFor(() => expect(screen.getByText('RAMADAN-BONUS')).toBeInTheDocument());
    expect(screen.getByText('CASHBACK · 95% of cap (warns at 85%)')).toBeInTheDocument();
  });

  it("note 2: the row is reachable — clicking it navigates to the existing campaigns list (no dedicated pause UI exists to link to instead, see this file's own header)", async () => {
    mockGet.mockResolvedValue({ data: { data: { alerts: [ONE_ALERT] } } });
    renderWidget();
    await waitFor(() => expect(screen.getByText('RAMADAN-BONUS')).toBeInTheDocument());
    screen.getByText('RAMADAN-BONUS').closest('tr')?.click();
    expect(mockNavigate).toHaveBeenCalledWith('/campaigns');
  });

  it('uses an explanatory empty message when there are no flagged alerts', async () => {
    mockGet.mockResolvedValue({ data: { data: { alerts: [] } } });
    renderWidget();
    await waitFor(() =>
      expect(
        screen.getByText('No campaigns are near a budget or cap threshold'),
      ).toBeInTheDocument(),
    );
  });

  it('shows the table error row on failure, via the shared Table error state', async () => {
    mockGet.mockRejectedValue({ isAxiosError: true, response: { status: 502 }, message: 'boom' });
    renderWidget();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});
