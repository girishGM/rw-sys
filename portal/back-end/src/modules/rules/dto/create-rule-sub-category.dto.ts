/**
 * T-106 — `POST /rule-sub-categories`. `super_admin` only. `categoryId` is required and
 * write-once — moving a sub-category to a different category later is out of scope (see this
 * task's own task file).
 */
import { IsInt, IsString, MaxLength, MinLength } from 'class-validator';
import { RULE_CATEGORY_CODE_MAX_LENGTH, RULE_CATEGORY_NAME_MAX_LENGTH } from '../rules.constants';

export class CreateRuleSubCategoryDto {
  @IsInt()
  categoryId!: number;

  @IsString()
  @MinLength(2)
  @MaxLength(RULE_CATEGORY_CODE_MAX_LENGTH)
  subCategoryCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(RULE_CATEGORY_NAME_MAX_LENGTH)
  name!: string;
}
