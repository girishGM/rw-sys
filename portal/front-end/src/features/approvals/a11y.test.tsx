/**
 * T-038 TC-25 — *"axe scan: zero violations"*.
 *
 * Same real, `axe-core`-engine approach `features/definition-requests/a11y.test.tsx` (T-042) and
 * `features/versions/a11y.test.tsx` (T-041) establish — see those files for why this is a genuine
 * scan rather than a heuristic substitute, and for the one honest jsdom limitation
 * (`color-contrast`, which needs real layout and paint) that is excluded.
 *
 * The decision dialog is scanned **open**, because that is the state this screen exists for and
 * the one with a focus trap, a required-field relationship and a live error region in it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as axe from 'axe-core';
import type { ApprovalDetail, ApprovalRequest } from '@reward-portal/shared';

const { mockUseApprovalsQuery, mockUseApprovalQuery } = vi.hoisted(() => ({
  mockUseApprovalsQuery: vi.fn(),
  mockUseApprovalQuery: vi.fn(),
}));

vi.mock('./api', () => ({
  useApprovalsQuery: mockUseApprovalsQuery,
  useApprovalQuery: mockUseApprovalQuery,
  useDecideApprovalMutation: () => ({
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null,
  }),
}));

import { ApprovalsQueuePage } from './ApprovalsQueuePage';
import { ApprovalDetailPage } from './ApprovalDetailPage';

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

const REQUEST: ApprovalRequest = {
  id: 11,
  tenantId: 7,
  entityType: 'campaign',
  entityId: 42,
  action: 'create',
  status: 'pending',
  effectiveStatus: 'pending',
  requestedBy: 100,
  requestedByName: 'Aisha Maker',
  requestedAt: '2026-08-18T09:00:00.000Z',
  reviewedBy: null,
  reviewedByName: null,
  reviewedAt: null,
  reviewComment: null,
  expiresAt: '2026-08-25T09:00:00.000Z',
  actionable: true,
  selfSubmitted: false,
  decidable: true,
  subject: {
    campaignId: 42,
    campaignCode: 'T038_CODE',
    campaignName: 'Raya bonus',
    campaignStatus: 'pending_approval',
  },
  createdAt: '2026-08-18T09:00:00.000Z',
  updatedAt: '2026-08-18T09:00:00.000Z',
};

const DETAIL: ApprovalDetail = {
  request: REQUEST,
  diff: {
    renderable: true,
    problem: null,
    changed: [{ field: 'name', label: 'Name', before: 'Raya bonus', after: 'Raya bonus v2' }],
    unchangedCount: 3,
    skippedFields: ['endDate'],
    budgets: [
      {
        unitType: 'currency',
        unitCode: 'MYR',
        campaignBudget: '100000.00',
        maxCampaignBudget: '500000.00',
        percentOfCeiling: 20,
        state: 'ok',
      },
    ],
    warnings: ['UNBUDGETED_REWARD_UNIT'],
    trackerCount: 1,
    componentCount: 2,
  },
};

function renderQueue() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/approvals']}>
        <Routes>
          <Route path="/approvals" element={<ApprovalsQueuePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderDetail(detail: ApprovalDetail = DETAIL) {
  mockUseApprovalQuery.mockReturnValue({ data: detail, isLoading: false, error: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/approvals/11']}>
        <Routes>
          <Route path="/approvals/:id" element={<ApprovalDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUseApprovalsQuery.mockReset();
  mockUseApprovalQuery.mockReset();
});
afterEach(() => {
  cleanup();
});

describe('T-038 TC-25 — ApprovalsQueuePage axe scan', () => {
  it('the loading state has no violations', async () => {
    mockUseApprovalsQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    const { container } = renderQueue();
    await scan(container, 'ApprovalsQueuePage — loading');
  });

  it('the empty state has no violations', async () => {
    mockUseApprovalsQuery.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 20, total: 0 } },
      isLoading: false,
      error: null,
    });
    const { container } = renderQueue();
    await screen.findByText('Nothing waiting for review');
    await scan(container, 'ApprovalsQueuePage — empty');
  });

  it('a populated, paginated queue has no violations', async () => {
    mockUseApprovalsQuery.mockReturnValue({
      data: {
        data: [REQUEST, { ...REQUEST, id: 12, selfSubmitted: true, decidable: false }],
        meta: { page: 1, pageSize: 20, total: 200 },
      },
      isLoading: false,
      error: null,
    });
    const { container } = renderQueue();
    await screen.findAllByText('Raya bonus');
    await scan(container, 'ApprovalsQueuePage — populated');
  });
});

describe('T-038 TC-25 — ApprovalDetailPage axe scan', () => {
  it('a decidable request has no violations', async () => {
    const { container } = renderDetail();
    await screen.findByRole('button', { name: 'Approve' });
    await scan(container, 'ApprovalDetailPage — decidable');
  });

  it('a self-submitted request (actions replaced by an explanation) has no violations', async () => {
    const { container } = renderDetail({
      ...DETAIL,
      request: { ...REQUEST, selfSubmitted: true, decidable: false },
    });
    await screen.findByText(/segregation of duty/i);
    await scan(container, 'ApprovalDetailPage — self-submitted');
  });

  it('the unrenderable-diff fallback has no violations', async () => {
    const { container } = renderDetail({
      ...DETAIL,
      diff: {
        renderable: false,
        problem: 'PAYLOAD_NOT_AN_OBJECT',
        changed: [],
        unchangedCount: 0,
        skippedFields: [],
        budgets: [],
        warnings: [],
        trackerCount: null,
        componentCount: null,
      },
    });
    await screen.findByText('Cannot show a comparison');
    await scan(container, 'ApprovalDetailPage — diff fallback');
  });

  it('the open reject dialog has no violations', async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog');

    // The dialog subtree, not `container` and not `document.body`. `container` misses it entirely
    // (the dialog renders through a portal), and `body` would additionally scan the *page-level*
    // `region` rule against a page rendered here without the `AppShell` landmarks it has in the
    // real app — a finding about this test's harness, not about this component.
    await scan(dialog, 'ApprovalDetailPage — reject dialog open');
  });
});
