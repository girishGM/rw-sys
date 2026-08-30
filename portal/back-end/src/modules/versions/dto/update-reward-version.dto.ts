/**
 * T-041 — `PATCH /rewards/:id/versions/:vid`. Mirrors `UpdateRuleVersionDto` exactly, over the
 * reward-version payload shape (`connector_config`, `delivery_mode`, `retry_config`,
 * `policies_snapshot`, `unit_type`/`unit_code` — 06-VERSIONING.md §5.1/11-BUDGETS-AND-LIMITS.md
 * §3.1). `super_admin` only, **draft only** (see `UpdateRuleVersionDto`'s own header).
 *
 * `connector_config` is stored as plain JSON-in-`text`, unencrypted — a disclosed, already-
 * escalated gap this task does not re-open (`T017_002_seed_policies.ts`'s own comment: *"the
 * two-phase AAD binding ... needs one UPDATE after INSERT ... encryption and immutability are
 * mutually exclusive on this table as it stands. Escalated."*), matching
 * `reward-version.model.ts`'s own plain getter/setter treatment of the column.
 */
import { IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { REWARD_KINDS } from '@reward-portal/shared';
import { CHANGE_SUMMARY_MAX_LENGTH } from '../versions.constants';

/** `reward_versions.unit_type` — 11-BUDGETS-AND-LIMITS.md §3.1; mirrors `campaign-cap.model.ts`'s
 * `UnitType`, duplicated as a literal tuple here rather than imported, the same choice
 * `rules.constants.ts` documents for its own enums. */
const UNIT_TYPES = ['currency', 'points', 'voucher'] as const;

export class UpdateRewardVersionDto {
  @IsOptional()
  @IsObject()
  connectorConfig?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  deliveryMode?: string | null;

  @IsOptional()
  @IsObject()
  retryConfig?: Record<string, unknown>;

  @IsOptional()
  policiesSnapshot?: unknown;

  @IsOptional()
  @IsIn(UNIT_TYPES)
  unitType?: (typeof UNIT_TYPES)[number] | null;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  unitCode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(CHANGE_SUMMARY_MAX_LENGTH)
  changeSummary?: string | null;

  /**
   * T-119 — `reward_versions.reward_kind` (13-REWARD-MASTER-VALUE-SOURCES.md §5). Nullable:
   * clearing the Kind back to "not set" on a draft must stay possible, the same way T-109's
   * resolver wiring stays clearable. Only the *vocabulary* is checked here; whether
   * {@link valueConfig} matches the Kind is a cross-field question the service answers, because
   * on a `PATCH` the other half of the pair may be the one already stored on the draft.
   */
  @IsOptional()
  @IsIn(REWARD_KINDS)
  rewardKind?: (typeof REWARD_KINDS)[number] | null;

  /** T-119 — `reward_versions.value_config`. Shape-checked against `rewardKind` by
   * `RewardVersionsService`, never here; see {@link rewardKind}. */
  @IsOptional()
  @IsObject()
  valueConfig?: Record<string, unknown> | null;

  @IsOptional()
  @IsBoolean()
  isBreaking?: boolean;

  @IsOptional()
  @IsBoolean()
  confirmBreakingOverride?: boolean;
}
