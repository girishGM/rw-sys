/**
 * T-038 — the response shapes of `/approvals`, and the mappers that build them.
 *
 * Every type is imported from `packages/shared` rather than redeclared, for the reason
 * `campaigns/dto/campaign-response.dto.ts` (T-037) gives in full: the SPA parses each response
 * through the very same Zod schema, so a mapper that forgets a field fails the front end's own
 * contract test rather than shipping a silent `undefined` deep in a screen.
 *
 * ### The three booleans are computed here, once
 *
 * `actionable`, `selfSubmitted` and `decidable` (see `approval.schema.ts`'s header for what each
 * means) are derived in {@link toApprovalDto} from the stored row plus the **verified** actor —
 * never from anything a client sent. `decidable` in particular is what the SPA renders its
 * buttons from, and it is deliberately *not* what the server enforces: `ApprovalsService`
 * re-derives the same facts before every write, so a `curl` that never saw a button meets the
 * same 422/409 (TC-6, TC-17).
 */
import type {
  ApprovalDetail,
  ApprovalDiff,
  ApprovalRequest,
  ApprovalStatus,
  ApprovalSubject,
} from '@reward-portal/shared';
import { effectiveApprovalStatus } from '@reward-portal/shared';
import type { TenantCampaign } from '@/database/models';
import type { PortalApprovalRequest } from '@/database/portal-models';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { APPROVAL_STATUS } from '../approvals.constants';

/** 03-API-CONTRACT.md §1 — `{ data }` for a single resource, `{ data, meta }` for a list. */
export interface DataEnvelope<T> {
  readonly data: T;
}

export interface ListMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface DataListEnvelope<T> {
  readonly data: readonly T[];
  readonly meta: ListMeta;
}

export function envelope<T>(data: T): DataEnvelope<T> {
  return { data };
}

/** The lookups a queue page resolves in bulk, passed in rather than fetched per row. */
export interface ApprovalRowContext {
  readonly requesterName: string | null;
  readonly reviewerName: string | null;
  readonly campaign: TenantCampaign | null;
}

/** The campaign a request concerns, for the queue. `null` for a request whose subject is not a
 * campaign, or is outside the caller's scope — the latter being indistinguishable from "gone", as
 * 02-SECURITY.md §5.1 requires. */
export function toApprovalSubject(campaign: TenantCampaign | null): ApprovalSubject | null {
  if (campaign === null) return null;
  return {
    campaignId: campaign.id,
    campaignCode: campaign.campaignCode,
    campaignName: campaign.name,
    campaignStatus: campaign.status,
  };
}

/**
 * One approval request as the wire sees it.
 *
 * `now` is a parameter rather than a `new Date()` inside, so a test can pin the expiry boundary
 * and so every row of one page is evaluated against a single instant — otherwise a page rendered
 * across a millisecond boundary could show two rows with the same `expiresAt` in different
 * states, which is the kind of thing that gets reported as a ghost bug and never reproduced.
 */
export function toApprovalDto(
  row: PortalApprovalRequest,
  actor: AuthenticatedUser,
  context: ApprovalRowContext,
  now: Date,
): ApprovalRequest {
  const effectiveStatus = effectiveApprovalStatus(
    { status: row.status, expiresAt: row.expiresAt },
    now,
  );
  const actionable = effectiveStatus === APPROVAL_STATUS.PENDING;
  const selfSubmitted = row.requestedBy === actor.userId;

  return {
    id: row.id,
    tenantId: row.tenantId,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action as ApprovalRequest['action'],
    status: row.status as ApprovalStatus,
    effectiveStatus,
    requestedBy: row.requestedBy,
    requestedByName: context.requesterName,
    requestedAt: row.requestedAt.toISOString(),
    reviewedBy: row.reviewedBy,
    reviewedByName: context.reviewerName,
    reviewedAt: row.reviewedAt === null ? null : row.reviewedAt.toISOString(),
    reviewComment: row.reviewComment,
    expiresAt: row.expiresAt.toISOString(),
    actionable,
    selfSubmitted,
    // The role check is `=== 'checker'` rather than a permission lookup on purpose: this field
    // exists to drive a button, and it must agree with `assertRole(actor, 'checker')` in the
    // service — which consults no table either (see `assert-role.ts`'s header on why the
    // code-level assertion is deliberately not data-driven).
    decidable: actionable && !selfSubmitted && actor.role === 'checker',
    subject: toApprovalSubject(context.campaign),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** `GET /approvals/:id` — the request plus its rendered diff. */
export function toApprovalDetailDto(request: ApprovalRequest, diff: ApprovalDiff): ApprovalDetail {
  return { request, diff };
}
