import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Globe2 } from 'lucide-react';
import { createKpiWidget } from '../../../src/features/dashboard/widgets/KpiWidget';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('../../../src/lib/apiClient', () => ({ api: { get: mockGet } }));

function renderWidget(Widget: ReturnType<typeof createKpiWidget>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Widget label="Countries" config={{ type: 'kpi' }} />
    </QueryClientProvider>,
  );
}

// `cleanup()` runs here, at the *start* of every test (before the next mock is armed), rather
// than only in `afterEach` — with a query that settles (resolve or reject) in one test and a
// fresh render in the next, deferring the previous test's unmount to a separate `afterEach`
// hook left a real, reproducible window where the *next* test's rejected `queryFn` promise was
// flagged as unhandled by Vitest even though `useQuery` handles it correctly (confirmed with a
// bare `useQuery` + `vi.fn()` repro with no widget code involved at all — a tooling timing
// interaction, not a bug in `KpiWidget`). Cleaning up synchronously before arming the next
// mock removes the overlap entirely.
beforeEach(() => {
  cleanup();
  mockGet.mockReset();
});

describe('createKpiWidget', () => {
  it('fetches GET /dashboard/widgets/:key and renders the resolved value', async () => {
    mockGet.mockImplementation(() => Promise.resolve({ data: { data: { value: 12 } } }));
    const Widget = createKpiWidget('kpi_countries', { icon: Globe2 });
    renderWidget(Widget);

    expect(mockGet).toHaveBeenCalledWith('/dashboard/widgets/kpi_countries');
    await waitFor(() => expect(screen.getByText('12')).toBeInTheDocument());
  });

  it('shows an error tile, not a crash, when the request fails', async () => {
    mockGet.mockImplementation(() =>
      Promise.reject({ isAxiosError: true, response: { status: 500 }, message: 'boom' }),
    );
    const Widget = createKpiWidget('kpi_countries');
    renderWidget(Widget);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load Countries."),
    );
  });

  it('shows a placeholder while loading, never the eventual value early', () => {
    mockGet.mockImplementation(() => new Promise(() => undefined));
    const Widget = createKpiWidget('kpi_countries');
    renderWidget(Widget);
    expect(screen.getByText('Countries')).toBeInTheDocument();
    expect(screen.queryByText('12')).not.toBeInTheDocument();
  });

  it('renders the trend when the response carries one', async () => {
    mockGet.mockImplementation(() =>
      Promise.resolve({
        data: { data: { value: 5, trend: { direction: 'up', value: '+2', label: 'this week' } } },
      }),
    );
    const Widget = createKpiWidget('kpi_countries');
    renderWidget(Widget);
    await waitFor(() => expect(screen.getByText('+2')).toBeInTheDocument());
    expect(screen.getByText('this week')).toBeInTheDocument();
  });
});
