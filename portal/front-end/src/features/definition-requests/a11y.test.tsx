/**
 * T-042 — TC-22 ("axe scan — zero violations"). Same real, `axe-core`-engine approach
 * `features/versions/a11y.test.tsx` (T-041) establishes — see that file's own header for why
 * this is a genuine scan and not a heuristic substitute, and for the one honest jsdom
 * limitation (`color-contrast`, which needs real layout/paint) it excludes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as axe from 'axe-core';
import type { Bootstrap, DefinitionRequest } from '@reward-portal/shared';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';

const { mockUseDefinitionRequestsQuery, mockUseDefinitionRequestQuery } = vi.hoisted(() => ({
  mockUseDefinitionRequestsQuery: vi.fn(),
  mockUseDefinitionRequestQuery: vi.fn(),
}));

vi.mock('./api', () => ({
  useDefinitionRequestsQuery: mockUseDefinitionRequestsQuery,
  useDefinitionRequestQuery: mockUseDefinitionRequestQuery,
  useCreateDefinitionRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateDefinitionRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useWithdrawDefinitionRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReviewDefinitionRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useFulfilDefinitionRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { DefinitionRequestsListPage } from './DefinitionRequestsListPage';
import { DefinitionRequestDetailPage } from './DefinitionRequestDetailPage';

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

function bootstrapValue(role: Bootstrap['user']['role']): BootstrapContextValue {
  return {
    user: { id: 1, displayName: 'Test User', role, locale: 'en', timezone: null },
    scope: { countryId: 9, tenantId: null, merchantId: null },
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

function renderList(role: Bootstrap['user']['role'] = 'super_admin') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(role)}>
        <MemoryRouter initialEntries={['/definition-requests']}>
          <Routes>
            <Route path="/definition-requests" element={<DefinitionRequestsListPage />} />
          </Routes>
        </MemoryRouter>
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

function renderDetail(role: Bootstrap['user']['role'] = 'super_admin') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(role)}>
        <MemoryRouter initialEntries={['/definition-requests/1']}>
          <Routes>
            <Route path="/definition-requests/:id" element={<DefinitionRequestDetailPage />} />
          </Routes>
        </MemoryRouter>
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

const row: DefinitionRequest = {
  id: 1,
  requestType: 'new_rule',
  entityId: null,
  requestedBy: 1,
  requestingCountryId: 9,
  requestingTenantId: null,
  title: 'Weekend multiplier',
  description: 'We need a weekend multiplier rule.',
  businessJustification: 'Boosts weekend transaction volume.',
  desiredBy: '2026-03-01',
  priority: 'high',
  status: 'submitted',
  reviewedBy: null,
  reviewedAt: null,
  reviewComment: null,
  fulfilledVersionId: null,
  fulfilledAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  mockUseDefinitionRequestsQuery.mockReset();
  mockUseDefinitionRequestQuery.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('TC-22 — DefinitionRequestsListPage axe scan', () => {
  it('the loading state has no violations', async () => {
    mockUseDefinitionRequestsQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    const { container } = renderList();
    await scan(container, 'DefinitionRequestsListPage — loading');
  });

  it('the empty state has no violations', async () => {
    mockUseDefinitionRequestsQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });
    const { container } = renderList();
    await screen.findByText('No definition requests yet');
    await scan(container, 'DefinitionRequestsListPage — empty');
  });

  it('a populated list has no violations', async () => {
    mockUseDefinitionRequestsQuery.mockReturnValue({
      data: { data: [row], meta: { page: 1, pageSize: 20, total: 1 } },
      isLoading: false,
      error: null,
    });
    const { container } = renderList();
    await screen.findByText('Weekend multiplier');
    await scan(container, 'DefinitionRequestsListPage — populated');
  });
});

describe('TC-22 — DefinitionRequestDetailPage axe scan', () => {
  it('a submitted request, viewed by its requester, has no violations', async () => {
    mockUseDefinitionRequestQuery.mockReturnValue({ data: row, isLoading: false, error: null });
    const { container } = renderDetail('country_admin');
    await screen.findByText('Weekend multiplier');
    await scan(container, 'DefinitionRequestDetailPage — submitted, requester');
  });

  it('an under_review request, viewed by super_admin (with the triage panel open), has no violations', async () => {
    mockUseDefinitionRequestQuery.mockReturnValue({
      data: { ...row, status: 'under_review' },
      isLoading: false,
      error: null,
    });
    const { container } = renderDetail('super_admin');
    await screen.findByRole('button', { name: /^reject$/i });
    await scan(container, 'DefinitionRequestDetailPage — under_review, super_admin');
  });

  it('an approved request, viewed by super_admin (with the fulfil panel open), has no violations', async () => {
    mockUseDefinitionRequestQuery.mockReturnValue({
      data: { ...row, status: 'approved' },
      isLoading: false,
      error: null,
    });
    const { container } = renderDetail('super_admin');
    await screen.findByLabelText(/published version id/i);
    await scan(container, 'DefinitionRequestDetailPage — approved, super_admin');
  });
});
