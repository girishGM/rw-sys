/**
 * T-038 — the `/approvals` API layer.
 *
 * Two things are worth pinning here, and neither is "the URL is right":
 *
 *  1. **Every response is parsed, not cast.** A server that grows or loses a field must surface as
 *     a caught, reported error on this feature rather than as a silent `undefined` on a checker's
 *     screen — `approvalListEnvelopeSchema` is `.strict()`, so both directions fail loudly.
 *  2. **The request body is built by the shared schema.** `approveApprovalRequestSchema` and
 *     `commentedDecisionRequestSchema` are the same objects the server's DTO re-parses, so the
 *     SPA cannot send a body the server would reject for a reason the SPA does not know about.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApprovalDetail, ApprovalRequest } from '@reward-portal/shared';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));

vi.mock('../../lib/apiClient', () => ({ api: { get: mockGet, post: mockPost } }));

import {
  approvalQueryKey,
  approvalsQueryKey,
  approveApproval,
  fetchApproval,
  fetchApprovals,
  rejectApproval,
  returnApproval,
  useApprovalQuery,
  useApprovalsQuery,
  useDecideApprovalMutation,
} from './api';

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
    changed: [],
    unchangedCount: 4,
    skippedFields: [],
    budgets: [],
    warnings: [],
    trackerCount: 1,
    componentCount: 2,
  },
};

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('T-038 · approvals api — reads', () => {
  it('fetches the queue and returns the parsed envelope', async () => {
    mockGet.mockResolvedValue({
      data: { data: [REQUEST], meta: { page: 1, pageSize: 20, total: 1 } },
    });

    const result = await fetchApprovals({ status: 'pending' });

    expect(mockGet).toHaveBeenCalledWith('/approvals', { params: { status: 'pending' } });
    expect(result.data[0].id).toBe(11);
  });

  /**
   * A contract drift is rejected, and the *reason* survives on `cause`.
   *
   * `toApiError` (T-022) deliberately normalises anything that is not a server error envelope to
   * one generic, non-leaking message — implementation note 5's *"feature code never invents its
   * own copy for a server-side failure"*, applied to a failure the server did not describe. So the
   * assertion here is on `cause`, which is what an operator reading `console.error` sees, not on
   * the rendered text.
   */
  async function shapeErrorCause(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      return String((error as { cause?: unknown }).cause);
    }
    throw new Error('expected the call to reject');
  }

  it('reports a contract drift instead of handing a half-shape to the UI', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ id: 11 }], meta: {} } });

    await expect(shapeErrorCause(fetchApprovals({}))).resolves.toMatch(
      /did not match the expected shape/,
    );
  });

  it('rejects an unexpected extra field — `.strict()` in both directions', async () => {
    mockGet.mockResolvedValue({
      data: {
        data: [{ ...REQUEST, somethingNew: true }],
        meta: { page: 1, pageSize: 20, total: 1 },
      },
    });

    await expect(shapeErrorCause(fetchApprovals({}))).resolves.toMatch(
      /did not match the expected shape/,
    );
  });

  it('fetches one request with its diff', async () => {
    mockGet.mockResolvedValue({ data: { data: DETAIL } });

    const result = await fetchApproval(11);

    expect(mockGet).toHaveBeenCalledWith('/approvals/11');
    expect(result.diff.renderable).toBe(true);
  });

  it('keys queries so one decision can invalidate the whole feature', () => {
    expect(approvalsQueryKey({ status: 'pending' })[0]).toBe('approvals');
    expect(approvalQueryKey(11)).toEqual(['approvals', 11]);
  });
});

describe('T-038 · approvals api — the three decisions', () => {
  beforeEach(() => {
    mockPost.mockResolvedValue({ data: { data: { ...REQUEST, status: 'approved' } } });
  });

  it('approves with no body at all when there is no comment', async () => {
    await approveApproval(11);

    expect(mockPost).toHaveBeenCalledWith('/approvals/11/approve', {});
  });

  it('trims an approval comment rather than sending whitespace', async () => {
    await approveApproval(11, '  looks right  ');

    expect(mockPost).toHaveBeenCalledWith('/approvals/11/approve', { comment: 'looks right' });
  });

  it('treats a whitespace-only approval comment as no comment', async () => {
    await approveApproval(11, '    ');

    expect(mockPost).toHaveBeenCalledWith('/approvals/11/approve', {});
  });

  it('posts a rejection with its mandatory comment', async () => {
    await rejectApproval(11, 'Budget too aggressive.');

    expect(mockPost).toHaveBeenCalledWith('/approvals/11/reject', {
      comment: 'Budget too aggressive.',
    });
  });

  it('posts a return with its mandatory comment', async () => {
    await returnApproval(11, 'Add a referral tracker.');

    expect(mockPost).toHaveBeenCalledWith('/approvals/11/return', {
      comment: 'Add a referral tracker.',
    });
  });

  it.each([
    ['an empty comment', ''],
    ['a whitespace-only comment', '   '],
    ['a comment past 500 characters', 'x'.repeat(501)],
  ])('refuses to send %s — the same rule the server enforces', async (_label, comment) => {
    await expect(rejectApproval(11, comment)).rejects.toBeDefined();
    await expect(returnApproval(11, comment)).rejects.toBeDefined();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('refuses an approval comment past 500 characters too', async () => {
    await expect(approveApproval(11, 'x'.repeat(501))).rejects.toBeDefined();
    expect(mockPost).not.toHaveBeenCalled();
  });
});

/**
 * The hooks themselves, rendered for real.
 *
 * The page suites mock this module wholesale — which is right for testing a screen and wrong for
 * testing the wiring, because a query key typo or a mutation that routes `return` to `reject`
 * would pass every one of those tests. These run the actual hooks against a real `QueryClient`.
 */
describe('T-038 · approvals api — the hooks', () => {
  function wrapper() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
  }

  it('useApprovalsQuery fetches the queue', async () => {
    mockGet.mockResolvedValue({
      data: { data: [REQUEST], meta: { page: 1, pageSize: 20, total: 1 } },
    });

    const { result } = renderHook(() => useApprovalsQuery({ status: 'pending' }), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.data[0].id).toBe(11);
  });

  it('useApprovalQuery fetches one request', async () => {
    mockGet.mockResolvedValue({ data: { data: DETAIL } });

    const { result } = renderHook(() => useApprovalQuery(11), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.request.id).toBe(11);
  });

  it('useApprovalQuery stays idle for a null id rather than requesting /approvals/0', () => {
    const { result } = renderHook(() => useApprovalQuery(null), { wrapper: wrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it.each([
    ['approve', '/approvals/11/approve'],
    ['reject', '/approvals/11/reject'],
    ['return', '/approvals/11/return'],
  ] as const)('useDecideApprovalMutation routes %s to its own endpoint', async (decision, path) => {
    mockPost.mockResolvedValue({ data: { data: REQUEST } });

    const { result } = renderHook(() => useDecideApprovalMutation(11), { wrapper: wrapper() });
    result.current.mutate({ decision, comment: 'Because.' });

    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost).toHaveBeenCalledWith(path, { comment: 'Because.' });
  });
});
