/**
 * T-106 — `POST /rule-categories`. `super_admin` only. `status` is never accepted here — a new
 * category is always `active` (same discipline `CreateRuleDto` uses for `rule_master.status`).
 */
import { IsString, MaxLength, MinLength } from 'class-validator';
import { RULE_CATEGORY_CODE_MAX_LENGTH, RULE_CATEGORY_NAME_MAX_LENGTH } from '../rules.constants';

export class CreateRuleCategoryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(RULE_CATEGORY_CODE_MAX_LENGTH)
  categoryCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(RULE_CATEGORY_NAME_MAX_LENGTH)
  name!: string;
}
