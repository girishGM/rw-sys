/**
 * T-042 — `PATCH /definition-requests/:id`. Requester only, and only while `status: 'submitted'`
 * (TC-6/TC-7, checked in the service — a state transition is a business rule, not a shape rule).
 * `requestType`/`entityId` are not editable: they define *what* is being asked for, and changing
 * them after submission would silently invalidate whatever triage already happened.
 */
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  BUSINESS_JUSTIFICATION_MAX_LENGTH,
  DEFINITION_REQUEST_PRIORITIES,
  DESCRIPTION_MIN_LENGTH,
  TITLE_MAX_LENGTH,
  type DefinitionRequestPriorityValue,
} from '../definition-requests.constants';

export class UpdateDefinitionRequestDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(TITLE_MAX_LENGTH)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(DESCRIPTION_MIN_LENGTH)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(BUSINESS_JUSTIFICATION_MAX_LENGTH)
  businessJustification?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  desiredBy?: string;

  @IsOptional()
  @IsIn(DEFINITION_REQUEST_PRIORITIES)
  priority?: DefinitionRequestPriorityValue;
}
