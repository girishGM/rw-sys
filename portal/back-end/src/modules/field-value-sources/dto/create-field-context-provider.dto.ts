/**
 * T-121 — `POST /field-context-providers`. `super_admin` only. `status` is never accepted here —
 * a new context provider is always `active` (same discipline `CreateRuleCategoryDto` uses).
 */
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  PROVIDER_CODE_MAX_LENGTH,
  PROVIDER_CODE_PATTERN,
  PROVIDER_DESCRIPTION_MAX_LENGTH,
  PROVIDER_NAME_MAX_LENGTH,
} from '../field-value-sources.constants';

export class CreateFieldContextProviderDto {
  @IsString()
  @MinLength(2)
  @MaxLength(PROVIDER_CODE_MAX_LENGTH)
  @Matches(PROVIDER_CODE_PATTERN, {
    message: 'providerCode must be upper snake case, e.g. SIBLING_COMPONENTS',
  })
  providerCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(PROVIDER_NAME_MAX_LENGTH)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(PROVIDER_DESCRIPTION_MAX_LENGTH)
  description?: string;
}
