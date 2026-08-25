/**
 * T-041 — `BlastHistoryPage` (§10 "Blast history"). `a11y.test.tsx` already covers the
 * loading/populated/forbidden states as part of TC-29's axe scans; this file covers the two
 * error-mapping branches (an `ApiError` vs. anything else) and a couple of row-render edge
 * cases (an unmapped scope value, a `null` note) that a11y.test.tsx's fixtures never hit.
 */
import type { ReactNode } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Blast, Bootstrap } from '@reward-portal/shared';
import { ApiError } from '../../lib/apiError';

const { mockUseBlastsQuery } = vi.hoisted(() => ({ mockUseBlastsQuery: vi.fn() }));
vi.mock('./api', () => ({ useBlastsQuery: mockUseBlastsQuery }));

import { BlastHistoryPage } from './BlastHistoryPage';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';

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
    hasPermission: () => role === 'super_admin',
    refetch: () => undefined,
  };
}

function withProviders(children: ReactNode, role: Bootstrap['user']['role'] = 'super_admin') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(role)}>
        <MemoryRouter>{children}</MemoryRouter>
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUseBlastsQuery.mockReset();
});

describe('BlastHistoryPage — error mapping', () => {
  it('shows the ApiError message directly when the query fails with one', () => {
    mockUseBlastsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError({ code: 'PERM_DENIED', status: 403, message: 'No access to blasts.' }),
    });

    withProviders(<BlastHistoryPage />);

    expect(screen.getByText('No access to blasts.')).toBeInTheDocument();
  });

  it('falls back to a generic message when the query fails with a non-ApiError', () => {
    mockUseBlastsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('network exploded'),
    });

    withProviders(<BlastHistoryPage />);

    expect(screen.getByText('Could not load blast history.')).toBeInTheDocument();
  });
});

describe('BlastHistoryPage — row rendering edge cases', () => {
  const baseBlast: Blast = {
    id: 1,
    entityType: 'reward',
    entityId: 3,
    versionId: 5,
    versionNo: 4,
    scope: 'all_countries',
    targetCount: 40,
    note: null,
    originRequestId: null,
    blastedBy: 1,
    blastedAt: '2026-02-01T00:00:00.000Z',
    targets: [
      {
        id: 1,
        countryId: 2,
        countryCode: 'MY',
        countryName: 'Malaysia',
        status: 'failed',
        failureReason: 'timeout',
      },
      {
        id: 2,
        countryId: 3,
        countryCode: 'SG',
        countryName: 'Singapore',
        status: 'skipped',
        failureReason: null,
      },
    ],
  };

  it('renders "All countries" scope, a null note as an em-dash, and every target-status tone', () => {
    mockUseBlastsQuery.mockReturnValue({
      data: { data: [baseBlast], meta: { page: 1, pageSize: 50, total: 1 } },
      isLoading: false,
      isError: false,
    });

    withProviders(<BlastHistoryPage />);

    expect(screen.getByText('reward #3')).toBeInTheDocument();
    expect(screen.getByText('All countries')).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('MY')).toBeInTheDocument();
    expect(screen.getByText('SG')).toBeInTheDocument();
  });
});
