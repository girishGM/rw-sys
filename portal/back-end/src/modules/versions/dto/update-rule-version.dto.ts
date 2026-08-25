/**
 * T-041 — `PATCH /rules/:id/versions/:vid`. `super_admin` only, **draft only** — the service
 * refuses on any other status before this DTO's fields are ever read (`VersionInvalidTransitionError`,
 * TC-4); the T-005 trigger refuses again at the database if that check were ever bypassed.
 *
 * `confirmBreakingOverride` is required (`true`) when `isBreaking` is supplied and disagrees
 * with the system's own suggestion — implementation note 9.
 */
import { IsBoolean, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { CHANGE_SUMMARY_MAX_LENGTH, RULE_EXPRESSION_MAX_LENGTH } from '../versions.constants';

export class UpdateRuleVersionDto {
  @IsOptional()
  @IsString()
  @MaxLength(RULE_EXPRESSION_MAX_LENGTH)
  expression?: string | null;

  @IsOptional()
  @IsObject()
  parameters?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(CHANGE_SUMMARY_MAX_LENGTH)
  changeSummary?: string | null;

  @IsOptional()
  @IsBoolean()
  isBreaking?: boolean;

  @IsOptional()
  @IsBoolean()
  confirmBreakingOverride?: boolean;
}
