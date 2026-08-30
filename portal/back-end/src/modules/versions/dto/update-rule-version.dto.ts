/**
 * T-041 — `PATCH /rules/:id/versions/:vid`. `super_admin` only, **draft only** — the service
 * refuses on any other status before this DTO's fields are ever read (`VersionInvalidTransitionError`,
 * TC-4); the T-005 trigger refuses again at the database if that check were ever bypassed.
 *
 * `confirmBreakingOverride` is required (`true`) when `isBreaking` is supplied and disagrees
 * with the system's own suggestion — implementation note 9.
 *
 * T-109 — `resolverId`/`resolverConfig`/`evaluationContext`/`defaultOperators` wire a draft
 * version to the registry-driven rule engine (T-102/T-103). All four are optional **and**
 * nullable: `undefined` means "leave as is", `null` means "clear the wiring back to inert" —
 * the task file's own implementation note 1 requires clearing to stay possible. The service
 * (`rule-versions.service.ts#updateDraft`) validates `resolverId` against `rule_resolvers` and
 * each `defaultOperators` entry against `rule_operators`; `resolverConfig` is accepted as
 * opaque JSON, same tolerance `expression`/`parameters` already get (task file's own Scope
 * "Out" note).
 */
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { CHANGE_SUMMARY_MAX_LENGTH, RULE_EXPRESSION_MAX_LENGTH } from '../versions.constants';

/** `reward_config.rule_versions.evaluation_context` is `varchar(50)` (`T103_001`) — validated
 * here so an over-length value fails as a normal 400 rather than a raw DB error. */
const EVALUATION_CONTEXT_MAX_LENGTH = 50;

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

  /** `rule_resolvers.id` — validated for existence in the service, not here (a DTO-level check
   * cannot see the database). */
  @IsOptional()
  @IsInt()
  resolverId?: number | null;

  /** Opaque JSON — see the file doc comment's "Out" note. */
  @IsOptional()
  @IsObject()
  resolverConfig?: Record<string, unknown> | null;

  @IsOptional()
  @IsString()
  @MaxLength(EVALUATION_CONTEXT_MAX_LENGTH)
  evaluationContext?: string | null;

  /** Each entry validated against `rule_operators.operator_code` in the service. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  defaultOperators?: string[] | null;
}
