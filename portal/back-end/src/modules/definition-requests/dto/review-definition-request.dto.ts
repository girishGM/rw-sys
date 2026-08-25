/**
 * T-042 — `POST /definition-requests/:id/review`. `super_admin` only. One endpoint moves a
 * request to any of the three states `DEFINITION_REQUEST_REVIEW_TRANSITIONS` allows a `.../review`
 * call to reach (`under_review`, `approved`, `rejected`) — the target `status` is a body field,
 * not three separate routes, because all three share the same authority check and the same
 * "does this move make sense from here" question (`definition-requests.service.ts#review`).
 *
 * `reviewComment` is required when `status: 'rejected'` — checked in the service (implementation
 * note 3), not by `@ValidateIf` here, because the message the service raises
 * (`RejectionCommentRequiredError`) is the one both `TC-10`'s `curl` verification step and the
 * UI's inline error read from.
 */
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  DEFINITION_REQUEST_REVIEW_TARGET_STATUSES,
  REVIEW_COMMENT_MAX_LENGTH,
  type DefinitionRequestReviewTargetStatusValue,
} from '../definition-requests.constants';

export class ReviewDefinitionRequestDto {
  @IsIn(DEFINITION_REQUEST_REVIEW_TARGET_STATUSES)
  status!: DefinitionRequestReviewTargetStatusValue;

  @IsOptional()
  @IsString()
  @MaxLength(REVIEW_COMMENT_MAX_LENGTH)
  reviewComment?: string;
}
