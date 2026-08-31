/**
 * T-041 — TC-29 ("axe scan of version and blast screens — zero violations"). Same real,
 * `axe-core`-engine approach `features/trace/a11y.test.tsx` (T-045) establishes — see that
 * file's own header for why this is a genuine scan and not a heuristic substitute, and for the
 * one honest jsdom limitation (`color-contrast`, which needs real layout/paint) it excludes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as axe from 'axe-core';
import type { Bootstrap, RuleVersion } from '@reward-portal/shared';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';

const {
  mockUseVersionsQuery,
  mockUseCreateDraftMutation,
  mockUseVersionTransitionMutation,
  mockUseVersionDiffQuery,
  mockUseUpdateDraftMutation,
  mockUseRuleResolversQuery,
  mockUseRuleOperatorsQuery,
} = vi.hoisted(() => ({
  mockUseVersionsQuery: vi.fn(),
  mockUseCreateDraftMutation: vi.fn(),
  mockUseVersionTransitionMutation: vi.fn(),
  mockUseVersionDiffQuery: vi.fn(),
  mockUseUpdateDraftMutation: vi.fn(),
  mockUseRuleResolversQuery: vi.fn(),
  mockUseRuleOperatorsQuery: vi.fn(),
}));

vi.mock('./api', () => ({
  useVersionsQuery: mockUseVersionsQuery,
  useCreateDraftMutation: mockUseCreateDraftMutation,
  useVersionTransitionMutation: mockUseVersionTransitionMutation,
  useVersionDiffQuery: mockUseVersionDiffQuery,
  useUpdateDraftMutation: mockUseUpdateDraftMutation,
}));
// T-110 — `EditVersionDraftModal`'s resolver-wiring fields (opened below, "Edit draft" scan).
vi.mock('../rules/api', () => ({
  useRuleResolversQuery: mockUseRuleResolversQuery,
  useRuleOperatorsQuery: mockUseRuleOperatorsQuery,
}));

import userEvent from '@testing-library/user-event';
import { VersionsPanel } from './VersionsPanel';

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

function renderPanel(role: Bootstrap['user']['role'] = 'super_admin') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(role)}>
        <VersionsPanel entityType="rule" entityId={1} entityLabel="MIN_SPEND_TIER" />
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

const draftVersion: RuleVersion = {
  id: 2,
  ruleId: 1,
  versionNo: 2,
  expression: 'amount >= 100',
  parameters: { fields: [] },
  changeSummary: 'weekend bump',
  isBreaking: false,
  status: 'draft',
  supersedesVersionId: 1,
  originRequestId: null,
  createdBy: 1,
  createdAt: '2026-08-14T00:00:00.000Z',
  publishedBy: null,
  publishedAt: null,
  deprecatedAt: null,
  retiredAt: null,
  updatedAt: '2026-08-14T00:00:00.000Z',
  suggestedIsBreaking: false,
};

const publishedVersion: RuleVersion = {
  ...draftVersion,
  id: 1,
  versionNo: 1,
  status: 'published',
  supersedesVersionId: null,
  publishedBy: 1,
  publishedAt: '2026-08-01T00:00:00.000Z',
  suggestedIsBreaking: null,
};

beforeEach(() => {
  mockUseVersionsQuery.mockReset();
  mockUseCreateDraftMutation.mockReset();
  mockUseVersionTransitionMutation.mockReset();
  mockUseVersionDiffQuery.mockReset();
  mockUseCreateDraftMutation.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  mockUseVersionTransitionMutation.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  mockUseVersionDiffQuery.mockReturnValue({ data: undefined, isLoading: false });
  mockUseUpdateDraftMutation.mockReset();
  mockUseUpdateDraftMutation.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  mockUseRuleResolversQuery.mockReset();
  mockUseRuleResolversQuery.mockReturnValue({
    data: [
      {
        id: 1,
        resolverCode: 'TRACKER_STATE_LOOKUP',
        name: 'Sibling Tracker Component Lookup',
        description: null,
        status: 'active',
        resolverInputFieldKeys: ['targetComponentCode'],
      },
    ],
  });
  mockUseRuleOperatorsQuery.mockReset();
  mockUseRuleOperatorsQuery.mockReturnValue({
    data: [
      {
        id: 1,
        operatorCode: 'equals',
        displayName: 'Equals',
        expectedValueType: 'string',
        status: 'active',
      },
    ],
  });
});

afterEach(() => {
  cleanup();
});

describe('TC-29 — VersionsPanel axe scan', () => {
  it('the loading state has no violations', async () => {
    mockUseVersionsQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    const { container } = renderPanel();
    await scan(container, 'VersionsPanel — loading');
  });

  it('the empty state has no violations', async () => {
    mockUseVersionsQuery.mockReturnValue({ data: [], isLoading: false, isError: false });
    const { container } = renderPanel();
    await screen.findByText('No versions yet.');
    await scan(container, 'VersionsPanel — empty');
  });

  it('a populated timeline (draft + published, super_admin) has no violations', async () => {
    mockUseVersionsQuery.mockReturnValue({
      data: [draftVersion, publishedVersion],
      isLoading: false,
      isError: false,
    });
    const { container } = renderPanel('super_admin');
    await screen.findByText('v2');
    await scan(container, 'VersionsPanel — populated, super_admin');
  });

  it('a populated timeline for a read-only role has no violations', async () => {
    mockUseVersionsQuery.mockReturnValue({
      data: [publishedVersion],
      isLoading: false,
      isError: false,
    });
    const { container } = renderPanel('country_admin');
    await screen.findByText('v1');
    await scan(container, 'VersionsPanel — populated, country_admin');
  });

  it('the error state has no violations', async () => {
    mockUseVersionsQuery.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    const { container } = renderPanel();
    await screen.findByText('Could not load versions');
    await scan(container, 'VersionsPanel — error');
  });

  // T-110 — the resolver/evaluation-context/operators fields added to "Edit draft".
  it('the "Edit draft" modal, with resolver wiring fields shown, has no violations', async () => {
    mockUseVersionsQuery.mockReturnValue({
      data: [draftVersion, publishedVersion],
      isLoading: false,
      isError: false,
    });
    const user = userEvent.setup();
    const { container } = renderPanel('super_admin');
    await screen.findByText('v2');

    await user.click(screen.getByRole('button', { name: /edit/i }));
    await screen.findByText(/Edit draft v2/);

    await scan(container, 'EditVersionDraftModal — resolver wiring fields');
  });
});
