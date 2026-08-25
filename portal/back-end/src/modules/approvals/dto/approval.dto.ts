/**
 * T-038 — the request bodies and query strings of `/approvals`.
 *
 * Same two layers `campaigns/dto/campaign.dto.ts` (T-037) establishes: per-field
 * `class-validator` decorators for precise `details` entries, plus one
 * `@MatchesSharedContract(...)` against the very Zod schema the SPA validated with, so every
 * cross-field rule exists exactly once. See `campaigns/dto/shared-contract.decorator.ts` for the
 * full argument — including the one rule about never attaching it beside `@IsOptional()`, which
 * {@link ApproveApprovalDto} below observes.
 *
 * ### What is not here
 *
 * **No `tenantId`, no `reviewedBy`, no `status`.** AGENT-PROTOCOL R3: the tenant comes from the
 * verified JWT via `ScopedRepository`, the reviewer is the authenticated actor, and the resulting
 * status is decided by which *route* was called, never by a field. A body that could name its own
 * outcome would make `POST /approvals/:id/reject` and `POST /approvals/:id/approve` the same
 * endpoint wearing two hats, and only one of them is permission-checked for `approve`.
 */
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import {
  APPROVAL_COMMENT_MAX_LENGTH,
  approveApprovalRequestSchema,
  commentedDecisionRequestSchema,
} from '@reward-portal/shared';
import { MatchesSharedContract } from '@/modules/campaigns/dto/shared-contract.decorator';

/**
 * `GET /approvals` — 03-API-CONTRACT.md §1's pagination plus two whitelisted filters. No generic
 * query DSL: both filters below are explicit, enumerated parameters.
 *
 * `status` filters the **stored** column, which is the only thing SQL can filter on. A row that
 * is stored `pending` but is past `expires_at` therefore still appears under `status=pending` —
 * and appears with `effectiveStatus: 'expired'` and `actionable: false`, which is TC-14 working
 * as specified rather than a leak in the filter. Hiding it would be worse: a checker would see a
 * request vanish from the queue with no record of why.
 */
export class ListApprovalsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;

  @IsOptional()
  @IsString()
  @Matches(/^(pending|approved|rejected|expired|returned)$/, {
    message: 'status must be one of the five approval statuses',
  })
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-z_]+$/, { message: 'entityType must be a lower-case entity name' })
  entityType?: string;
}

/**
 * `POST /approvals/:id/approve` — an optional comment.
 *
 * `comment` carries **only** the contract decorator and deliberately no `@IsOptional()`:
 * `class-validator` short-circuits every validator on a conditionally-validated property, so an
 * `@IsOptional()` here would stop the shared-contract check from running in exactly the case it
 * is needed (a body that omits `comment` but carries an unexpected key, or one whose `comment` is
 * 501 characters). The property is still whitelisted for `forbidNonWhitelisted` because it has a
 * registered decorator, and the length/optionality rules live once in
 * `approveApprovalRequestSchema`.
 */
export class ApproveApprovalDto {
  @MatchesSharedContract(approveApprovalRequestSchema)
  comment?: string;
}

/**
 * `POST /approvals/:id/reject` and `POST /approvals/:id/return` — comment **mandatory**
 * (03-API-CONTRACT.md §12, implementation note 4).
 *
 * One class for both routes because the body is genuinely identical; the decisions differ in what
 * they do, not in what they accept. TC-8/TC-10 (*"without a comment → 400"*) fall out of
 * `@IsString()` on a required property; TC-11 (*"longer than 500 → 400"*) from `@MaxLength`,
 * which is `varchar(500)` restated; and a whitespace-only comment from the shared schema's own
 * `.refine`, which the second layer runs.
 */
export class CommentedDecisionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(APPROVAL_COMMENT_MAX_LENGTH)
  @MatchesSharedContract(commentedDecisionRequestSchema)
  comment!: string;
}
