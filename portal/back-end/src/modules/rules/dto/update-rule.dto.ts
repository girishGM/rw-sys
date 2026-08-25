/**
 * T-031 — `PATCH /rules/:id`. `super_admin` only.
 *
 * `ruleCode` is immutable (the same discipline `update-country.dto.ts` applies to `code`) —
 * never here. Every field is optional (a partial update), but the *set* of allowed names is
 * fixed: an undeclared key is a 400 (`forbidNonWhitelisted`) under the global `ValidationPipe`.
 *
 * `@IsOptional()` skips validation for **both** `null` and `undefined` (its own source:
 * *"ignores all validators"* when the value is missing) — which is exactly the pair of
 * meanings `expression` needs: `undefined` (omitted) leaves it unchanged, `null` clears a
 * previously-set expression, and either way `@IsString()` is never asked to validate it.
 */
import { IsIn, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import {
  RULE_EXPRESSION_MAX_LENGTH,
  RULE_NAME_MAX_LENGTH,
  RULE_STATUSES,
  type RuleStatusValue,
} from '../rules.constants';
import { IsRuleParameters } from './rule-validators.decorators';

export class UpdateRuleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(RULE_NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @IsInt()
  subCategoryId?: number;

  /** `null` clears a previously-set expression; omitted leaves it unchanged. */
  @IsOptional()
  @IsString()
  @MaxLength(RULE_EXPRESSION_MAX_LENGTH)
  expression?: string | null;

  @IsOptional()
  @IsRuleParameters()
  parameters?: Record<string, unknown>;

  /** `status='inactive'` hides the rule from new-campaign pickers only (implementation note 7)
   * — never disturbs a campaign already using it. */
  @IsOptional()
  @IsIn(RULE_STATUSES)
  status?: RuleStatusValue;
}
