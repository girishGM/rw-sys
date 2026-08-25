/**
 * T-038 — the detail screen: the diff (TC-19/TC-20) and the three decisions (TC-8/TC-10/TC-11).
 *
 * The comment rules are asserted here **and** in `approvals.e2e-spec.ts` against the real server,
 * deliberately: this suite proves the SPA does not let a checker submit an empty rejection, and
 * the e2e suite proves the server refuses one anyway. Neither is a substitute for the other — the
 * first is the experience, the second is the control.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApprovalDetail, ApprovalDiff, ApprovalRequest } from '@reward-portal/shared';

const { mockUseApprovalQuery, mockMutate, mockReset } = vi.hoisted(() => ({
  mockUseApprovalQuery: vi.fn(),
  mockMutate: vi.fn(),
  mockReset: vi.fn(),
}));

let mutationError: { message: string } | null = null;

vi.mock('./api', () => ({
  useApprovalQuery: mockUseApprovalQuery,
  useDecideApprovalMutation: () => ({
    mutate: mockMutate,
    reset: mockReset,
    isPending: false,
    error: mutationError,
  }),
}));

import { ApprovalDetailPage } from './ApprovalDetailPage';

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

const RENDERABLE_DIFF: ApprovalDiff = {
  renderable: true,
  problem: null,
  changed: [{ field: 'name', label: 'Name', before: 'Raya bonus', after: 'Raya bonus (revised)' }],
  unchangedCount: 3,
  skippedFields: [],
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
  warnings: [],
  trackerCount: 1,
  componentCount: 2,
};

function renderDetail(detail: Partial<ApprovalDetail> = {}) {
  mockUseApprovalQuery.mockReturnValue({
    data: { request: REQUEST, diff: RENDERABLE_DIFF, ...detail },
    isLoading: false,
    error: null,
  });
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
  mockUseApprovalQuery.mockReset();
  mockMutate.mockReset();
  mockReset.mockReset();
  mutationError = null;
});
afterEach(() => {
  cleanup();
});

describe('T-038 · ApprovalDetailPage — the three decisions', () => {
  it('renders all three actions for a decidable request', () => {
    renderDetail();

    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Return for rework' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('TC-6: explains WHY, rather than showing three dead buttons, when the caller submitted it', () => {
    renderDetail({ request: { ...REQUEST, selfSubmitted: true, decidable: false } });

    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByText(/segregation of duty/i)).toBeInTheDocument();
  });

  it('TC-13/TC-14: an expired request says so and offers nothing', () => {
    renderDetail({
      request: {
        ...REQUEST,
        effectiveStatus: 'expired',
        actionable: false,
        decidable: false,
      },
    });

    expect(screen.getByText(/expired before it was reviewed/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('TC-12: an already-decided request shows the decision and its comment', () => {
    renderDetail({
      request: {
        ...REQUEST,
        status: 'rejected',
        effectiveStatus: 'rejected',
        actionable: false,
        decidable: false,
        reviewedBy: 200,
        reviewedByName: 'Bo Checker',
        reviewedAt: '2026-08-19T10:00:00.000Z',
        reviewComment: 'Budget too aggressive.',
      },
    });

    expect(screen.getByText(/already rejected/i)).toBeInTheDocument();
    expect(screen.getByText('Budget too aggressive.')).toBeInTheDocument();
  });

  it('approves without a comment', async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog');
    // The comment is genuinely optional here — agreeing with what the maker documented owes no
    // essay (implementation note 4).
    expect(within(dialog).getByRole('button', { name: 'Approve' })).toBeEnabled();
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));

    expect(mockMutate).toHaveBeenCalledWith(
      { decision: 'approve', comment: '' },
      expect.anything(),
    );
  });

  it.each([
    ['Reject', 'reject'],
    ['Return for rework', 'return'],
  ])('TC-8/TC-10: %s cannot be confirmed without a comment', async (label, decision) => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(screen.getByRole('button', { name: label }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', {
      name: decision === 'reject' ? 'Reject' : 'Return',
    });
    expect(confirm).toBeDisabled();

    // Whitespace is not a reason. `.min(1)` alone would have accepted it.
    await user.type(within(dialog).getByRole('textbox'), '   ');
    expect(confirm).toBeDisabled();

    await user.clear(within(dialog).getByRole('textbox'));
    await user.type(within(dialog).getByRole('textbox'), 'Please add a referral tracker.');
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    expect(mockMutate).toHaveBeenCalledWith(
      { decision, comment: 'Please add a referral tracker.' },
      expect.anything(),
    );
  });

  it('TC-11: a comment past 500 characters disables the action and says so', async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(screen.getByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog');
    // `paste` rather than `type`, because typing 501 characters one keystroke at a time is a
    // three-second test for no extra confidence.
    await user.click(within(dialog).getByRole('textbox'));
    await user.paste('x'.repeat(501));

    expect(within(dialog).getByRole('button', { name: 'Reject' })).toBeDisabled();
    expect(within(dialog).getByText(/limited to 500 characters/i)).toBeInTheDocument();
  });

  it('shows a server-side refusal inside the dialog rather than swallowing it', async () => {
    const user = userEvent.setup();
    mutationError = { message: 'You cannot approve a request you submitted yourself.' };
    renderDetail();

    await user.click(screen.getByRole('button', { name: 'Approve' }));

    expect(
      screen.getByText('You cannot approve a request you submitted yourself.'),
    ).toBeInTheDocument();
  });
});

describe('T-038 · ApprovalDetailPage — the states around the decision', () => {
  it('shows a loading state rather than an empty shell', () => {
    mockUseApprovalQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/approvals/11']}>
          <Routes>
            <Route path="/approvals/:id" element={<ApprovalDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('TC-4: a request in another tenant reads as unavailable, with the server’s own message', () => {
    mockUseApprovalQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { message: 'The requested resource was not found.' },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/approvals/11']}>
          <Routes>
            <Route path="/approvals/:id" element={<ApprovalDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByText('This request is not available')).toBeInTheDocument();
    expect(screen.getByText('The requested resource was not found.')).toBeInTheDocument();
  });

  it('TC-20: a request whose campaign is gone still renders, addressed by its own id', () => {
    renderDetail({ request: { ...REQUEST, subject: null, decidable: false, actionable: false } });

    expect(screen.getByRole('heading', { name: 'Approval request' })).toBeInTheDocument();
    expect(screen.getByText('Request #11')).toBeInTheDocument();
    // No campaign to link to, so no link — rather than a link to `/campaigns/undefined`.
    expect(screen.queryByRole('link', { name: /open the campaign/i })).not.toBeInTheDocument();
  });

  it('links to the campaign when there is one', () => {
    renderDetail();

    expect(screen.getByRole('link', { name: /open the campaign/i })).toHaveAttribute(
      'href',
      '/campaigns/42',
    );
  });

  it('explains a non-checker’s read-only view without inventing a different reason', () => {
    // `actionable` and `!selfSubmitted` both hold; the caller simply is not a checker (TC-2).
    renderDetail({ request: { ...REQUEST, decidable: false } });

    expect(screen.getByText(/only a checker can decide an approval request/i)).toBeInTheDocument();
  });

  it('names the reviewer even when the display name could not be resolved', () => {
    renderDetail({
      request: {
        ...REQUEST,
        status: 'approved',
        effectiveStatus: 'approved',
        actionable: false,
        decidable: false,
        reviewedBy: 200,
        reviewedByName: null,
        reviewedAt: '2026-08-19T10:00:00.000Z',
      },
    });

    expect(screen.getByText(/user 200/)).toBeInTheDocument();
  });

  it('speaks about the expiry in the past tense once a decision has been made', () => {
    renderDetail({
      request: {
        ...REQUEST,
        status: 'approved',
        effectiveStatus: 'approved',
        actionable: false,
        decidable: false,
      },
    });

    expect(screen.getByText(/Expiry was/)).toBeInTheDocument();
  });

  it('closes the dialog and clears the mutation error on cancel', async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // A stale "you cannot approve your own submission" must not survive into the next dialog.
    expect(mockReset).toHaveBeenCalled();
  });

  it('closes the dialog once the decision succeeds', async () => {
    const user = userEvent.setup();
    mockMutate.mockImplementation((_variables: unknown, options: { onSuccess: () => void }) => {
      options.onSuccess();
    });
    renderDetail();

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('T-038 · ApprovalDetailPage — the diff', () => {
  it('TC-19: shows before and after for changed fields only', () => {
    renderDetail();

    // Scoped to the diff table: "Raya bonus" is also the page heading, and an unscoped query
    // would be asserting on the header rather than on the comparison.
    const diffTable = screen.getByRole('table', { name: /fields changed since submission/i });
    const changedRow = within(diffTable).getByRole('row', { name: /name/i });
    expect(within(changedRow).getByText('Raya bonus')).toBeInTheDocument();
    expect(within(changedRow).getByText('Raya bonus (revised)')).toBeInTheDocument();
    // The budget context T-037 recorded so a checker does not have to do arithmetic.
    expect(screen.getByText('20%')).toBeInTheDocument();
  });

  it('TC-19: says so plainly when nothing changed', () => {
    renderDetail({
      diff: { ...RENDERABLE_DIFF, changed: [], unchangedCount: 4 },
    });

    expect(screen.getByText(/nothing has changed since this was submitted/i)).toBeInTheDocument();
  });

  it.each([
    ['PAYLOAD_MISSING', /nothing was recorded/i],
    ['PAYLOAD_NOT_AN_OBJECT', /not in a shape this screen can compare/i],
    ['SUBJECT_UNAVAILABLE', /no longer available to you/i],
  ] as const)(
    'TC-20: %s renders a readable fallback and the actions still work',
    async (problem, copy) => {
      const user = userEvent.setup();
      renderDetail({
        diff: {
          renderable: false,
          problem,
          changed: [],
          unchangedCount: 0,
          skippedFields: [],
          budgets: [],
          warnings: [],
          trackerCount: null,
          componentCount: null,
        },
      });

      expect(screen.getByText('Cannot show a comparison')).toBeInTheDocument();
      expect(screen.getByText(copy)).toBeInTheDocument();
      // A diff is a reading aid, not a precondition — the decision is still available.
      await user.click(screen.getByRole('button', { name: 'Approve' }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    },
  );

  it('admits when part of the diff could not be compared', () => {
    renderDetail({ diff: { ...RENDERABLE_DIFF, skippedFields: ['endDate'] } });

    expect(screen.getByText(/not compared: endDate/i)).toBeInTheDocument();
  });
});
