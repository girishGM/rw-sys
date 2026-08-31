/**
 * T-106 — `PATCH /rule-categories/:id`. `categoryCode` is immutable once created (never
 * accepted here — same discipline `UpdateRuleDto` applies to `ruleCode`).
 */
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { RULE_CATEGORY_NAME_MAX_LENGTH, RULE_STATUSES } from '../rules.constants';

export class UpdateRuleCategoryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(RULE_CATEGORY_NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @IsIn(RULE_STATUSES)
  status?: string;
}
