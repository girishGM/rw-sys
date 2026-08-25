import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../../lib/apiError';

const { mockUseTenantsWithoutCeilingQuery } = vi.hoisted(() => ({
  mockUseTenantsWithoutCeilingQuery: vi.fn(),
}));

vi.mock('./api', () => ({ useTenantsWithoutCeilingQuery: mockUseTenantsWithoutCeilingQuery }));

import { TenantsWithoutCeilingWidget } from './TenantsWithoutCeilingWidget';

function renderWidget() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TenantsWithoutCeilingWidget />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUseTenantsWithoutCeilingQuery.mockReset();
});

describe('TenantsWithoutCeilingWidget (implementation note 7, TC-28)', () => {
  it('lists every tenant with no budget ceiling configured', () => {
    mockUseTenantsWithoutCeilingQuery.mockReturnValue({
      data: [
        { id: 10, code: 'T001', name: 'Acme Retail', countryId: 1 },
        { id: 11, code: 'T002', name: 'Globex Corp', countryId: 1 },
      ],
      isLoading: false,
      isError: false,
    });

    renderWidget();

    expect(screen.getByText('Acme Retail')).toBeInTheDocument();
    expect(screen.getByText('Globex Corp')).toBeInTheDocument();
    expect(screen.getAllByText(/unlimited/i)).toHaveLength(2);
  });

  it('shows the empty state when every tenant has a ceiling', () => {
    mockUseTenantsWithoutCeilingQuery.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    });

    renderWidget();

    expect(screen.getByText(/every tenant has a budget ceiling/i)).toBeInTheDocument();
  });

  it('shows a loading skeleton', () => {
    mockUseTenantsWithoutCeilingQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });

    renderWidget();

    expect(screen.queryByText(/unlimited/i)).not.toBeInTheDocument();
  });

  it('shows the error state independently of the rest of the dashboard', () => {
    mockUseTenantsWithoutCeilingQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError({ code: 'PERM_DENIED', message: 'No access.', status: 403 }),
    });

    renderWidget();

    expect(screen.getByRole('alert')).toHaveTextContent('No access.');
  });
});
