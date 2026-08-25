import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createListWidget } from '../../../src/features/dashboard/widgets/ListWidget';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('../../../src/lib/apiClient', () => ({ api: { get: mockGet } }));

function renderWidget(Widget: ReturnType<typeof createListWidget>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Widget label="My Campaigns" config={{ type: 'list' }} />
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

describe('createListWidget', () => {
  it('renders each item once data resolves', async () => {
    mockGet.mockImplementation(() =>
      Promise.resolve({
        data: { data: { items: [{ id: 1, primary: 'Diwali Bonanza', secondary: 'draft' }] } },
      }),
    );
    const Widget = createListWidget('list_my_campaigns');
    renderWidget(Widget);
    await waitFor(() => expect(screen.getByText('Diwali Bonanza')).toBeInTheDocument());
    expect(screen.getByText('draft')).toBeInTheDocument();
  });

  it('uses the configured empty message when there are no items', async () => {
    mockGet.mockImplementation(() => Promise.resolve({ data: { data: { items: [] } } }));
    const Widget = createListWidget('list_my_campaigns', { emptyMessage: 'No campaigns yet' });
    renderWidget(Widget);
    await waitFor(() => expect(screen.getByText('No campaigns yet')).toBeInTheDocument());
  });

  it('shows the table error row on failure, via the shared Table error state', async () => {
    mockGet.mockImplementation(() =>
      Promise.reject({ isAxiosError: true, response: { status: 500 }, message: 'boom' }),
    );
    const Widget = createListWidget('list_my_campaigns');
    renderWidget(Widget);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});
