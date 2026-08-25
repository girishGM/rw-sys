/**
 * T-038 TC-1 / TC-2 — the checker's queue, and the maker's read-only view of the same rows.
 *
 * The server decides which rows exist (scope) and which of them this caller may decide
 * (`decidable`). This suite pins that the screen renders *that fact* rather than re-deriving it
 * from a role name — the drift that would show a checker a button the server refuses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApprovalRequest } from '@reward-portal/shared';

const { mockUseApprovalsQuery } = vi.hoisted(() => ({ mockUseApprovalsQuery: vi.fn() }));
const navigate = vi.fn();

vi.mock('./api', () => ({
  useApprovalsQuery: mockUseApprovalsQuery,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

import { ApprovalsQueuePage } from './ApprovalsQueuePage';

function row(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
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
    ...overrides,
  };
}

function renderQueue(data: readonly ApprovalRequest[], total = data.length) {
  mockUseApprovalsQuery.mockReturnValue({
    data: { data, meta: { page: 1, pageSize: 20, total } },
    isLoading: false,
    error: null,
  });
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

beforeEach(() => {
  mockUseApprovalsQuery.mockReset();
  navigate.mockReset();
});
afterEach(() => {
  cleanup();
});

describe('T-038 · ApprovalsQueuePage', () => {
  it('TC-1: defaults to the pending queue', () => {
    renderQueue([row()]);

    expect(mockUseApprovalsQuery).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', page: 1 }),
    );
  });

  it('TC-1: resolves the campaign so a checker never sees a bare id', () => {
    renderQueue([row()]);

    expect(screen.getByText('Raya bonus')).toBeInTheDocument();
    expect(screen.getByText('(T038_CODE)')).toBeInTheDocument();
    expect(screen.getByText('Aisha Maker')).toBeInTheDocument();
  });

  it('renders a request whose campaign is gone without crashing', () => {
    renderQueue([row({ subject: null })]);

    expect(screen.getByText('Campaign unavailable')).toBeInTheDocument();
  });

  it('TC-6 (the fact): a row the caller submitted is labelled as theirs', () => {
    renderQueue([row({ selfSubmitted: true, decidable: false })]);

    // Named, not merely disabled — see the queue page's own comment.
    expect(screen.getByText('Your submission')).toBeInTheDocument();
  });

  it('TC-2: a maker’s queue carries no per-row action at all', () => {
    renderQueue([row({ decidable: false })]);

    // The queue never renders Approve/Reject/Return; those live on the detail screen, behind
    // `decidable`. What matters here is that nothing decision-shaped leaks into a read-only view.
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
  });

  it('TC-14: a stale row shows its effective status, not the stored one', () => {
    renderQueue([row({ status: 'pending', effectiveStatus: 'expired', actionable: false })]);

    // Scoped to the table: the status *filter* also reads "Pending", and asserting on the whole
    // document would pass or fail for a reason that has nothing to do with the row.
    const table = screen.getByRole('table', { name: /approval requests/i });
    expect(within(table).getByText('Expired')).toBeInTheDocument();
    expect(within(table).queryByText('Pending')).not.toBeInTheDocument();
  });

  it('opens the detail screen when a row is clicked', async () => {
    const user = userEvent.setup();
    renderQueue([row()]);

    await user.click(screen.getByText('Raya bonus'));

    expect(navigate).toHaveBeenCalledWith('/approvals/11');
  });

  it('shows the empty state rather than an empty table', () => {
    renderQueue([]);

    expect(screen.getByText('Nothing waiting for review')).toBeInTheDocument();
  });

  it('surfaces a load failure instead of pretending the queue is empty', () => {
    mockUseApprovalsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { message: 'You do not have permission to perform this action.' },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ApprovalsQueuePage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      screen.getByText('You do not have permission to perform this action.'),
    ).toBeInTheDocument();
  });

  it('TC-24: paginates a long queue', async () => {
    const user = userEvent.setup();
    renderQueue([row()], 200);

    const pagination = screen.getByRole('navigation', { name: /pagination/i });
    expect(within(pagination).getByText(/200 requests/)).toBeInTheDocument();
    expect(within(pagination).getByRole('button', { name: 'Previous' })).toBeDisabled();

    await user.click(within(pagination).getByRole('button', { name: 'Next' }));

    expect(mockUseApprovalsQuery).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
  });

  it('filters by status, and resets to the first page when it changes', async () => {
    const user = userEvent.setup();
    renderQueue([row()], 200);

    await user.click(screen.getByRole('combobox', { name: /status/i }));
    await user.click(screen.getByRole('option', { name: 'Approved' }));

    expect(mockUseApprovalsQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'approved', page: 1 }),
    );
  });
});
