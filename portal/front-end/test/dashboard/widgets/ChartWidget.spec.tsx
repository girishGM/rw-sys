import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createChartWidget } from '../../../src/features/dashboard/widgets/ChartWidget';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('../../../src/lib/apiClient', () => ({ api: { get: mockGet } }));

function renderWidget(Widget: ReturnType<typeof createChartWidget>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Widget label="Campaigns by Country" config={{ type: 'chart' }} />
    </QueryClientProvider>,
  );
}

// See `KpiWidget.spec.tsx`'s identical comment: `cleanup()` runs here, before the next mock is
// armed, rather than only in a separate `afterEach` — that ordering removed a reproducible
// Vitest/TanStack-Query timing interaction where a later test's rejected `queryFn` was flagged
// as an unhandled rejection.
beforeEach(() => {
  cleanup();
  mockGet.mockReset();
});

describe('createChartWidget', () => {
  it('renders the chart once data resolves', async () => {
    mockGet.mockImplementation(() =>
      Promise.resolve({ data: { data: { series: [{ label: 'Malaysia', value: 4 }] } } }),
    );
    const Widget = createChartWidget('chart_campaigns_by_country');
    renderWidget(Widget);
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Campaigns by Country' })).toBeInTheDocument(),
    );
  });

  it('shows an empty state for a series with no points', async () => {
    mockGet.mockImplementation(() => Promise.resolve({ data: { data: { series: [] } } }));
    const Widget = createChartWidget('chart_campaigns_by_country');
    renderWidget(Widget);
    await waitFor(() => expect(screen.getByText('No data yet')).toBeInTheDocument());
  });

  it('shows an error tile on failure', async () => {
    mockGet.mockImplementation(() =>
      Promise.reject({ isAxiosError: true, response: { status: 500 }, message: 'boom' }),
    );
    const Widget = createChartWidget('chart_campaigns_by_country');
    renderWidget(Widget);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load Campaigns by Country."),
    );
  });
});
