/**
 * T-121 — `PATCH /field-context-providers/:id`. `providerCode` is immutable once created and is
 * never accepted here (same discipline `UpdateRuleCategoryDto` applies to `categoryCode`).
 *
 * That immutability is not only a convention: T-122 stores the provider code as the value-source
 * reference on a rule field, so renaming one would silently orphan every field pointing at it.
 */
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import {
  FIELD_CONTEXT_PROVIDER_STATUSES,
  PROVIDER_DESCRIPTION_MAX_LENGTH,
  PROVIDER_NAME_MAX_LENGTH,
} from '../field-value-sources.constants';

export class UpdateFieldContextProviderDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(PROVIDER_NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(PROVIDER_DESCRIPTION_MAX_LENGTH)
  description?: string;

  @IsOptional()
  @IsIn(FIELD_CONTEXT_PROVIDER_STATUSES)
  status?: string;
}
