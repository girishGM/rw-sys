/**
 * T-032 — `/rewards/:id/policies/:policyId/caps` (implementation note 5: "Caps live in
 * `reward_policy_caps`; expose read/write for super_admin only"). `reward_config.
 * reward_policy_caps` has no Sequelize model (T-003 did not model it) and `back-end/src/database/
 * models/**` is outside this task's `Files owned` (R9), so this module reaches it with a raw,
 * parameterised query (`reward-policy-caps.repository.ts`) — the same precedent
 * `campaign-usage.query.ts` (T-031) establishes for a table in the same situation, `reward_app`'s
 * live privileges checked against the real database before relying on them (see that file's
 * completion-report evidence).
 *
 * Column widths transcribed from `reward_config.reward_policy_caps`
 * (`cap_type varchar(30)`, `frequency_unit varchar(10)`, `max_total_amount decimal(18,4)`).
 */
import { IsIn, IsInt, IsNumber, IsOptional, IsPositive, MaxLength } from 'class-validator';

export const REWARD_POLICY_CAP_TYPES = [
  'per_customer',
  'per_campaign',
  'daily',
  'weekly',
  'monthly',
  'total',
] as const;
export type RewardPolicyCapTypeValue = (typeof REWARD_POLICY_CAP_TYPES)[number];

export const REWARD_POLICY_CAP_FREQUENCY_UNITS = ['day', 'week', 'month'] as const;
export type RewardPolicyCapFrequencyUnitValue = (typeof REWARD_POLICY_CAP_FREQUENCY_UNITS)[number];

export const REWARD_POLICY_CAP_STATUSES = ['active', 'inactive'] as const;
export type RewardPolicyCapStatusValue = (typeof REWARD_POLICY_CAP_STATUSES)[number];

export class CreateRewardPolicyCapDto {
  @IsIn(REWARD_POLICY_CAP_TYPES)
  @MaxLength(30)
  capType!: RewardPolicyCapTypeValue;

  @IsOptional()
  @IsInt()
  @IsPositive()
  frequencyValue?: number;

  @IsOptional()
  @IsIn(REWARD_POLICY_CAP_FREQUENCY_UNITS)
  frequencyUnit?: RewardPolicyCapFrequencyUnitValue;

  @IsOptional()
  @IsInt()
  @IsPositive()
  maxOccurrences?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  maxTotalAmount?: number;
}

export class UpdateRewardPolicyCapDto {
  @IsOptional()
  @IsInt()
  @IsPositive()
  frequencyValue?: number | null;

  @IsOptional()
  @IsIn(REWARD_POLICY_CAP_FREQUENCY_UNITS)
  frequencyUnit?: RewardPolicyCapFrequencyUnitValue | null;

  @IsOptional()
  @IsInt()
  @IsPositive()
  maxOccurrences?: number | null;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  maxTotalAmount?: number | null;

  @IsOptional()
  @IsIn(REWARD_POLICY_CAP_STATUSES)
  status?: RewardPolicyCapStatusValue;
}
