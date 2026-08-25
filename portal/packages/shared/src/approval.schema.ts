/**
 * T-038 — the wire contract of `/approvals`: the checker's queue, one request in full with its
 * diff, and the three decisions (approve / reject / return).
 *
 * Same discipline every other `*.schema.ts` in this package states in full: bytes on the wire
 * only, `.strict()` everywhere, no coercion, no defaults the server never sent — an unexpected
 * key fails the contract test rather than shipping silently.
 *
 * ### Three booleans, not one, and the difference between them is the control
 *
 * A queue row carries {@link approvalRequestSchema}'s `actionable`, `selfSubmitted` and
 * `decidable`, and they answer three genuinely different questions:
 *
 *  - **`actionable`** — is this request still in a state that *anyone* could decide? False for
 *    an already-approved, rejected, returned or expired request (T-038 TC-12/TC-13/TC-14).
 *  - **`selfSubmitted`** — did the caller submit this themself? This is the segregation-of-duty
 *    fact (03-API-CONTRACT.md §12), computed from `requested_by` against the **verified JWT**,
 *    never from anything the client sent.
 *  - **`decidable`** — may *this* caller decide *this* request right now: `actionable &&
 *    !selfSubmitted && the caller is a checker`.
 *
 * The SPA renders its Approve/Reject/Return buttons from `decidable` alone. That is a
 * convenience, **not** the control: `ApprovalsService` re-derives all three server-side and
 * answers 422 `SELF_APPROVAL_FORBIDDEN` / 409 to a `curl` that never saw a button (TC-6, TC-17).
 * Shipping the fact rather than the button state is what lets the two agree by construction.
 *
 * ### Why the diff has a `problem` field instead of throwing
 *
 * `portal_approval_requests.payload` is `jsonb`, so it always *parses* — but nothing constrains
 * its *shape*, and a row written by an older build, by a future entity type, or by hand can be a
 * scalar, an array, or an object missing every key the diff wants. T-038 implementation note 7 is
 * explicit that this must produce *"a readable 'cannot render diff' state, never a crash on a
 * checker's queue"* (TC-20). So {@link approvalDiffSchema} is total: it always parses, it names
 * what went wrong in `problem`, and it still carries whatever context it *could* extract.
 */
import { z } from 'zod';

// --- vocabulary ----------------------------------------------------------------------------------

/** `ck_par_status` (T037_001), verbatim. */
export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'returned',
] as const;
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/** `ck_par_action` (T037_001), verbatim. A campaign submission is always `create`. */
export const APPROVAL_ACTIONS = ['create', 'update', 'delete'] as const;
export const approvalActionSchema = z.enum(APPROVAL_ACTIONS);
export type ApprovalAction = z.infer<typeof approvalActionSchema>;

/**
 * `review_comment` is `varchar(500)`. The bound is stated once here and consumed by the SPA's
 * character counter, by the server DTO and by the server's own re-parse of the same bytes —
 * T-038 TC-11 (*"comment longer than 500 chars → 400"*) is the same number in all three places
 * because it is the same constant.
 */
export const APPROVAL_COMMENT_MAX_LENGTH = 500;

// --- the request ---------------------------------------------------------------------------------

/** The campaign a request concerns, resolved for the queue so a checker never sees a bare id. */
export const approvalSubjectSchema = z
  .object({
    campaignId: z.number().int(),
    campaignCode: z.string(),
    campaignName: z.string(),
    /** The campaign's own stored status right now — `pending_approval` for a live request. */
    campaignStatus: z.string(),
  })
  .strict();

export type ApprovalSubject = z.infer<typeof approvalSubjectSchema>;

/** One row of `GET /approvals`, and the header of `GET /approvals/:id`. */
export const approvalRequestSchema = z
  .object({
    id: z.number().int(),
    tenantId: z.number().int(),
    entityType: z.string(),
    entityId: z.number().int().nullable(),
    action: approvalActionSchema,
    /** As stored. May lag reality by up to one sweep — see `effectiveStatus`. */
    status: approvalStatusSchema,
    /**
     * What the checker is shown: `status`, or `expired` when a still-`pending` row is past
     * `expiresAt`. Implementation note 5 — *"treat any read of a stale row as expired, so
     * correctness does not depend on the scheduler having run"* (TC-14).
     */
    effectiveStatus: approvalStatusSchema,
    requestedBy: z.number().int(),
    requestedByName: z.string().nullable(),
    requestedAt: z.string(),
    reviewedBy: z.number().int().nullable(),
    reviewedByName: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    reviewComment: z.string().nullable(),
    expiresAt: z.string(),
    /** `effectiveStatus === 'pending'` — see this file's header. */
    actionable: z.boolean(),
    /** `requested_by === the verified caller` — the segregation-of-duty fact. */
    selfSubmitted: z.boolean(),
    /** `actionable && !selfSubmitted && the caller is a checker`. Drives the buttons only. */
    decidable: z.boolean(),
    /** `null` when the referenced entity is not a campaign, or is not visible to the caller. */
    subject: approvalSubjectSchema.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const approvalListMetaSchema = z
  .object({ page: z.number().int(), pageSize: z.number().int(), total: z.number().int() })
  .strict();

export const approvalListEnvelopeSchema = z
  .object({ data: z.array(approvalRequestSchema), meta: approvalListMetaSchema })
  .strict();

export const approvalEnvelopeSchema = z.object({ data: approvalRequestSchema }).strict();

// --- the diff ------------------------------------------------------------------------------------

/** Why a before/after diff could not be built. See this file's header. */
export const APPROVAL_DIFF_PROBLEMS = [
  /** `payload` is SQL `NULL` — nothing was recorded at submission time. */
  'PAYLOAD_MISSING',
  /** `payload` parses but is a scalar or an array, not the object the diff expects. */
  'PAYLOAD_NOT_AN_OBJECT',
  /** The campaign the request names is gone, or is outside the caller's scope. */
  'SUBJECT_UNAVAILABLE',
] as const;
export const approvalDiffProblemSchema = z.enum(APPROVAL_DIFF_PROBLEMS);
export type ApprovalDiffProblem = z.infer<typeof approvalDiffProblemSchema>;

/** One field whose submitted value differs from the entity's current value (TC-19). */
export const approvalDiffFieldSchema = z
  .object({
    field: z.string(),
    label: z.string(),
    /** As recorded in `payload` at submission time. */
    before: z.string().nullable(),
    /** As the entity stands now. */
    after: z.string().nullable(),
  })
  .strict();

export type ApprovalDiffField = z.infer<typeof approvalDiffFieldSchema>;

/**
 * One budget line lifted straight out of the submission payload.
 *
 * T-037 implementation note 18 put `percentOfCeiling` in the payload precisely so *"a checker
 * sees an unusual number without doing arithmetic"* (11-BUDGETS-AND-LIMITS.md §8.4). Carrying it
 * through unchanged is the entire reason it was written.
 */
export const approvalBudgetLineSchema = z
  .object({
    unitType: z.string(),
    unitCode: z.string(),
    /** Decimal string — money never crosses this boundary as a float. */
    campaignBudget: z.string(),
    maxCampaignBudget: z.string().nullable(),
    percentOfCeiling: z.number().nullable(),
    state: z.string(),
  })
  .strict();

export type ApprovalBudgetLine = z.infer<typeof approvalBudgetLineSchema>;

/**
 * The rendered diff. **Always parses** — every failure mode is a value in here, not an exception
 * (TC-20).
 */
export const approvalDiffSchema = z
  .object({
    /** True only when a real before/after comparison was possible. */
    renderable: z.boolean(),
    problem: approvalDiffProblemSchema.nullable(),
    /** Changed fields only (TC-19). Empty when the entity is unchanged since submission. */
    changed: z.array(approvalDiffFieldSchema),
    /** How many comparable fields matched. Lets the UI say "3 fields unchanged" honestly. */
    unchangedCount: z.number().int(),
    /** Fields present in `payload` whose value had a type the diff could not compare. */
    skippedFields: z.array(z.string()),
    budgets: z.array(approvalBudgetLineSchema),
    warnings: z.array(z.string()),
    trackerCount: z.number().int().nullable(),
    componentCount: z.number().int().nullable(),
  })
  .strict();

export type ApprovalDiff = z.infer<typeof approvalDiffSchema>;

/** `GET /approvals/:id` — the request plus everything the detail screen renders. */
export const approvalDetailSchema = z
  .object({ request: approvalRequestSchema, diff: approvalDiffSchema })
  .strict();

export type ApprovalDetail = z.infer<typeof approvalDetailSchema>;

export const approvalDetailEnvelopeSchema = z.object({ data: approvalDetailSchema }).strict();

// --- the three decisions -------------------------------------------------------------------------

/**
 * `POST /approvals/:id/approve`.
 *
 * The comment is **optional** here and mandatory on the other two, and that asymmetry is
 * deliberate rather than an oversight: approving is agreeing with what the maker already
 * documented, while rejecting or returning changes someone else's work and owes them a reason
 * (implementation note 4, TC-8/TC-10).
 */
export const approveApprovalRequestSchema = z
  .object({ comment: z.string().max(APPROVAL_COMMENT_MAX_LENGTH).optional() })
  .strict();

export type ApproveApprovalRequest = z.infer<typeof approveApprovalRequestSchema>;

/**
 * `POST /approvals/:id/reject` and `POST /approvals/:id/return` — comment mandatory
 * (03-API-CONTRACT.md §12).
 *
 * `.min(1)` alone would accept `"   "`, which is a comment in the same sense that an empty commit
 * message is a rationale. The refinement below rejects it, and the server re-parses these exact
 * bytes, so a `curl` posting whitespace gets the same 400 the SPA's disabled button prevents.
 */
export const commentedDecisionRequestSchema = z
  .object({ comment: z.string().min(1).max(APPROVAL_COMMENT_MAX_LENGTH) })
  .strict()
  .refine((value) => value.comment.trim() !== '', {
    message: 'comment must not be blank',
    path: ['comment'],
  });

export type CommentedDecisionRequest = z.infer<typeof commentedDecisionRequestSchema>;

/** Named aliases, so a call site reads as the decision it is making. */
export const rejectApprovalRequestSchema = commentedDecisionRequestSchema;
export const returnApprovalRequestSchema = commentedDecisionRequestSchema;

// --- helpers shared by both sides ----------------------------------------------------------------

/**
 * Whether a stored request is expired **as of `now`**, whether or not the sweeper has run.
 *
 * Exported and used by the server (`approvals.service.ts`, on every read and before every
 * decision) and by the SPA (to keep a queue open in a browser tab honest without a refetch). One
 * implementation, so the two cannot disagree about a boundary — which is the failure mode that
 * would let a checker click Approve on a request the server has already written off.
 */
export function isApprovalExpired(
  request: { readonly status: string; readonly expiresAt: string | Date },
  now: Date = new Date(),
): boolean {
  if (request.status === 'expired') return true;
  if (request.status !== 'pending') return false;
  const expiry =
    request.expiresAt instanceof Date ? request.expiresAt.getTime() : Date.parse(request.expiresAt);
  if (Number.isNaN(expiry)) return false;
  return expiry <= now.getTime();
}

/** {@link isApprovalExpired} applied — the status a reader should be shown (TC-14). */
export function effectiveApprovalStatus(
  request: { readonly status: string; readonly expiresAt: string | Date },
  now: Date = new Date(),
): ApprovalStatus {
  if (isApprovalExpired(request, now)) return 'expired';
  return request.status as ApprovalStatus;
}
