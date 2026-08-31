/**
 * T-106 — `PATCH /rule-sub-categories/:id`. `subCategoryCode`/`categoryId` are immutable once
 * created — neither is accepted here.
 */
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { RULE_CATEGORY_NAME_MAX_LENGTH, RULE_STATUSES } from '../rules.constants';

export class UpdateRuleSubCategoryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(RULE_CATEGORY_NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @IsIn(RULE_STATUSES)
  status?: string;
}
