/**
 * T-038 — the `/approvals` calls, following the shape `features/campaigns/api.ts` (T-037)
 * establishes: `lib/apiClient.ts`'s shared `api` instance, and every response parsed through the
 * matching `packages/shared/src/approval.schema.ts` schema — not just cast — so a server/SPA
 * contract drift surfaces as a caught, reported error on this feature rather than as a silent
 * `undefined` on a checker's screen.
 *
 * ### The request body is validated here as well as on the server
 *
 * The three decision mutations `parse()` their input through the same shared schema the server's
 * DTO re-parses. That is not a substitute for the server check — a `curl` never runs this file —
 * it is what makes the SPA's own "comment required" and "500 characters" rules impossible to
 * disagree with the server's, because both are `commentedDecisionRequestSchema`.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  approvalDetailEnvelopeSchema,
  approvalEnvelopeSchema,
  approvalListEnvelopeSchema,
  approveApprovalRequestSchema,
  commentedDecisionRequestSchema,
  type ApprovalDetail,
  type ApprovalRequest,
} from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { toApiError } from '../../lib/apiError';

export interface ApprovalListParams {
  readonly page?: number;
  readonly pageSize?: number;
  readonly status?: string;
  readonly entityType?: string;
}

export interface ApprovalListResult {
  readonly data: readonly ApprovalRequest[];
  readonly meta: { readonly page: number; readonly pageSize: number; readonly total: number };
}

/** The root key every `/approvals` query hangs off, so one decision can invalidate all of it. */
export const APPROVALS_ROOT_KEY = ['approvals'] as const;

export function approvalsQueryKey(params: ApprovalListParams = {}) {
  return ['approvals', params] as const;
}
export function approvalQueryKey(id: number) {
  return ['approvals', id] as const;
}

/** Parses `payload` or throws a readable contract error. One helper rather than the same six
 * lines per call, which is how one of them ends up not parsing at all. */
function parsed<T>(
  schema: {
    safeParse: (input: unknown) => { success: boolean; data?: T; error?: { message: string } };
  },
  payload: unknown,
  what: string,
): T {
  const result = schema.safeParse(payload);
  if (!result.success || result.data === undefined) {
    throw new Error(
      `${what} response did not match the expected shape: ${result.error?.message ?? ''}`,
    );
  }
  return result.data;
}

// --- reads ---------------------------------------------------------------------------------------

export async function fetchApprovals(params: ApprovalListParams): Promise<ApprovalListResult> {
  try {
    const response = await api.get<unknown>('/approvals', { params });
    return parsed(approvalListEnvelopeSchema, response.data, 'Approvals list');
  } catch (error) {
    throw toApiError(error);
  }
}

export function useApprovalsQuery(
  params: ApprovalListParams = {},
): UseQueryResult<ApprovalListResult, ReturnType<typeof toApiError>> {
  return useQuery({ queryKey: approvalsQueryKey(params), queryFn: () => fetchApprovals(params) });
}

export async function fetchApproval(id: number): Promise<ApprovalDetail> {
  try {
    const response = await api.get<unknown>(`/approvals/${String(id)}`);
    return parsed(approvalDetailEnvelopeSchema, response.data, 'Approval').data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useApprovalQuery(id: number | null) {
  return useQuery({
    queryKey: approvalQueryKey(id ?? 0),
    queryFn: () => fetchApproval(id as number),
    enabled: id !== null,
  });
}

// --- the three decisions -------------------------------------------------------------------------

async function decide(
  id: number,
  verb: 'approve' | 'reject' | 'return',
  body: unknown,
  what: string,
): Promise<ApprovalRequest> {
  try {
    const response = await api.post<unknown>(`/approvals/${String(id)}/${verb}`, body);
    return parsed(approvalEnvelopeSchema, response.data, what).data;
  } catch (error) {
    throw toApiError(error);
  }
}

export async function approveApproval(id: number, comment?: string): Promise<ApprovalRequest> {
  const payload = approveApprovalRequestSchema.parse(
    comment === undefined || comment.trim() === '' ? {} : { comment: comment.trim() },
  );
  return decide(id, 'approve', payload, 'Approve');
}

export async function rejectApproval(id: number, comment: string): Promise<ApprovalRequest> {
  return decide(id, 'reject', commentedDecisionRequestSchema.parse({ comment }), 'Reject');
}

export async function returnApproval(id: number, comment: string): Promise<ApprovalRequest> {
  return decide(id, 'return', commentedDecisionRequestSchema.parse({ comment }), 'Return');
}

/**
 * One mutation hook for all three decisions.
 *
 * Every one of them changes the campaign behind the request as well as the request itself, so the
 * campaign cache is invalidated too — otherwise a checker who approves and then follows the link
 * to the campaign sees `pending_approval` on a campaign that is already `active`.
 */
export function useDecideApprovalMutation(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      decision,
      comment,
    }: {
      decision: 'approve' | 'reject' | 'return';
      comment: string;
    }) => {
      if (decision === 'approve') return approveApproval(id, comment);
      if (decision === 'reject') return rejectApproval(id, comment);
      return returnApproval(id, comment);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: APPROVALS_ROOT_KEY });
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });
}
