/**
 * T-041 — TC-29 ("axe scan of version and blast screens — zero violations"). Same real,
 * `axe-core`-engine approach `features/trace/a11y.test.tsx` (T-045) establishes.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as axe from 'axe-core';
import type { Blast, Bootstrap, RuleVersion } from '@reward-portal/shared';

const {
  mockUseCountriesQuery,
  mockUsePreviewBlastMutation,
  mockUseCreateBlastMutation,
  mockUseBlastsQuery,
} = vi.hoisted(() => ({
  mockUseCountriesQuery: vi.fn(),
  mockUsePreviewBlastMutation: vi.fn(),
  mockUseCreateBlastMutation: vi.fn(),
  mockUseBlastsQuery: vi.fn(),
}));

vi.mock('../countries/api', () => ({ useCountriesQuery: mockUseCountriesQuery }));
vi.mock('./api', () => ({
  usePreviewBlastMutation: mockUsePreviewBlastMutation,
  useCreateBlastMutation: mockUseCreateBlastMutation,
  useBlastsQuery: mockUseBlastsQuery,
}));

import { BlastDialog } from './BlastDialog';
import { BlastHistoryPage } from './BlastHistoryPage';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';

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

const version: RuleVersion = {
  id: 1,
  ruleId: 1,
  versionNo: 1,
  expression: 'a >= 1',
  parameters: { fields: [] },
  changeSummary: null,
  isBreaking: false,
  status: 'published',
  supersedesVersionId: null,
  originRequestId: null,
  createdBy: 1,
  createdAt: '2026-08-01T00:00:00.000Z',
  publishedBy: 1,
  publishedAt: '2026-08-01T00:00:00.000Z',
  deprecatedAt: null,
  retiredAt: null,
  updatedAt: '2026-08-01T00:00:00.000Z',
  suggestedIsBreaking: null,
};

const blastRow: Blast = {
  id: 1,
  entityType: 'rule',
  entityId: 1,
  versionId: 1,
  versionNo: 1,
  scope: 'selected',
  targetCount: 1,
  note: 'weekend promo',
  originRequestId: null,
  blastedBy: 1,
  blastedAt: '2026-08-02T00:00:00.000Z',
  targets: [
    {
      id: 1,
      countryId: 2,
      countryCode: 'MY',
      countryName: 'Malaysia',
      status: 'delivered',
      failureReason: null,
    },
  ],
};

beforeEach(() => {
  mockUseCountriesQuery.mockReset();
  mockUsePreviewBlastMutation.mockReset();
  mockUseCreateBlastMutation.mockReset();
  mockUseBlastsQuery.mockReset();
  mockUseCountriesQuery.mockReturnValue({
    data: { data: [{ id: 2, code: 'MY', name: 'Malaysia' }] },
    isLoading: false,
  });
  mockUsePreviewBlastMutation.mockReturnValue({
    mutateAsync: vi.fn(),
    data: undefined,
    isPending: false,
    reset: vi.fn(),
  });
  mockUseCreateBlastMutation.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
});

afterEach(() => {
  cleanup();
});

describe('TC-29 — BlastDialog axe scan', () => {
  it('the initial (no preview yet) state has no violations', async () => {
    const { container } = withProviders(
      <BlastDialog
        open
        onClose={vi.fn()}
        entityType="rule"
        entityId={1}
        entityLabel="MIN_SPEND_TIER"
        version={version}
      />,
    );
    await screen.findByText(/Blast MIN_SPEND_TIER v1/);
    await scan(container, 'BlastDialog — initial');
  });

  it('the preview-populated state has no violations', async () => {
    mockUsePreviewBlastMutation.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
      reset: vi.fn(),
      data: {
        entityType: 'rule',
        entityId: 1,
        versionId: 1,
        versionNo: 1,
        isBreaking: true,
        countries: [
          {
            countryId: 2,
            countryCode: 'MY',
            countryName: 'Malaysia',
            currentVersionNo: null,
            willReceiveVersionNo: 1,
            activeCampaignsOnCurrentVersion: 0,
            isBreaking: true,
          },
        ],
      },
    });
    const { container } = withProviders(
      <BlastDialog
        open
        onClose={vi.fn()}
        entityType="rule"
        entityId={1}
        entityLabel="MIN_SPEND_TIER"
        version={version}
      />,
    );
    await screen.findByText('Malaysia', { exact: false });
    await scan(container, 'BlastDialog — preview populated, breaking');
  });

  it('selects "Selected countries" and opens the multi-select without violations', async () => {
    const user = userEvent.setup();
    const { container } = withProviders(
      <BlastDialog
        open
        onClose={vi.fn()}
        entityType="rule"
        entityId={1}
        entityLabel="MIN_SPEND_TIER"
        version={version}
      />,
    );
    await user.click(screen.getByRole('button', { name: /countries/i }));
    await scan(container, 'BlastDialog — country picker open');
  });
});

describe('TC-29 — BlastHistoryPage axe scan', () => {
  it('the loading state has no violations', async () => {
    mockUseBlastsQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    const { container } = withProviders(<BlastHistoryPage />);
    await scan(container, 'BlastHistoryPage — loading');
  });

  it('a populated table has no violations', async () => {
    mockUseBlastsQuery.mockReturnValue({
      data: { data: [blastRow], meta: { page: 1, pageSize: 50, total: 1 } },
      isLoading: false,
      isError: false,
    });
    const { container } = withProviders(<BlastHistoryPage />);
    await screen.findByText('MY');
    await scan(container, 'BlastHistoryPage — populated');
  });

  it('the forbidden state (maker) has no violations', async () => {
    const { container } = withProviders(<BlastHistoryPage />, 'maker');
    await screen.findByText(/don't have access/i);
    await scan(container, 'BlastHistoryPage — forbidden');
  });
});
