/**
 * T-032 — `/rewards/:id/policies`. `super_admin` only (03-API-CONTRACT.md §9). `config` is plain
 * JSON, never secret (unlike `connector_config`) — no special handling needed.
 */
import { IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import {
  REWARD_DESCRIPTION_MAX_LENGTH,
  REWARD_NAME_MAX_LENGTH,
  REWARD_POLICY_CODE_MAX_LENGTH,
} from '../rewards.constants';
import { IsRewardPolicyCode } from './reward-validators.decorators';

const REWARD_POLICY_STATUSES = ['active', 'inactive'] as const;
type RewardPolicyStatusValue = (typeof REWARD_POLICY_STATUSES)[number];

export class CreateRewardPolicyDto {
  @IsString()
  @MinLength(2)
  @MaxLength(REWARD_POLICY_CODE_MAX_LENGTH)
  @IsRewardPolicyCode()
  policyCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(REWARD_NAME_MAX_LENGTH)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(REWARD_DESCRIPTION_MAX_LENGTH)
  description?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

/** `policyCode` is immutable, never here — same discipline `update-reward.dto.ts` applies to
 * `systemCode`. */
export class UpdateRewardPolicyDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(REWARD_NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(REWARD_DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsIn(REWARD_POLICY_STATUSES)
  status?: RewardPolicyStatusValue;
}
