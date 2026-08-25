/**
 * T-031 — `POST /rules`. `super_admin` only (all three layers — see `rules.service.ts`).
 *
 * `tenantId`/`status` are never accepted here (AGENT-PROTOCOL R3/R2): the service always
 * writes `tenant_id = NULL` (01-DATABASE.md §4) and `status = 'active'` on create.
 */
import { IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import {
  RULE_EXPRESSION_MAX_LENGTH,
  RULE_CODE_MAX_LENGTH,
  RULE_NAME_MAX_LENGTH,
} from '../rules.constants';
import { IsRuleCode, IsRuleParameters } from './rule-validators.decorators';

export class CreateRuleDto {
  @IsString()
  @MinLength(2)
  @MaxLength(RULE_CODE_MAX_LENGTH)
  @IsRuleCode()
  ruleCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(RULE_NAME_MAX_LENGTH)
  name!: string;

  @IsInt()
  subCategoryId!: number;

  /** Inert text — the portal never runs it as code (implementation note 5). */
  @IsOptional()
  @IsString()
  @MaxLength(RULE_EXPRESSION_MAX_LENGTH)
  expression?: string;

  /** Validated against the shared meta-schema (implementation note 4). `@IsOptional()` so an
   * absent `parameters` is simply omitted rather than failing `@IsRuleParameters()`. */
  @IsOptional()
  @IsRuleParameters()
  parameters?: Record<string, unknown>;
}
