/**
 * T-032 — `PATCH /rewards/:id`. `super_admin` only.
 *
 * `systemCode` is immutable (the same discipline `update-rule.dto.ts` applies to `ruleCode`) —
 * never here. Every field is optional (a partial update), but the *set* of allowed names is
 * fixed: an undeclared key is a 400 (`forbidNonWhitelisted`) under the global `ValidationPipe`.
 */
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  REWARD_CONNECTOR_TYPES,
  REWARD_DELIVERY_MODES,
  REWARD_DESCRIPTION_MAX_LENGTH,
  REWARD_NAME_MAX_LENGTH,
  REWARD_STATUSES,
  REWARD_TYPE_MAX_LENGTH,
  type RewardConnectorTypeValue,
  type RewardDeliveryModeValue,
  type RewardStatusValue,
} from '../rewards.constants';
import { IsRewardConnectorConfig } from './reward-validators.decorators';

export class UpdateRewardDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(REWARD_NAME_MAX_LENGTH)
  name?: string;

  /** `null` clears a previously-set description; omitted leaves it unchanged. */
  @IsOptional()
  @IsString()
  @MaxLength(REWARD_DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(REWARD_TYPE_MAX_LENGTH)
  rewardType?: string;

  @IsOptional()
  @IsIn(REWARD_DELIVERY_MODES)
  deliveryMode?: RewardDeliveryModeValue;

  @IsOptional()
  @IsIn(REWARD_CONNECTOR_TYPES)
  connectorType?: RewardConnectorTypeValue;

  /** Replaces the whole `connectorConfig` (no partial merge) — encrypted before write. Audited
   * as "changed", never the value (implementation note 4, TC-13). */
  @IsOptional()
  @IsRewardConnectorConfig()
  connectorConfig?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  maintenanceWindowEnabled?: boolean;

  @IsOptional()
  @IsObject()
  maintenanceSchedule?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  retryEnabled?: boolean;

  @IsOptional()
  @IsObject()
  retryConfig?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  merchantId?: number | null;

  /** `status='inactive'` hides the reward from new-campaign pickers only (implementation note
   * 7's rule equivalent, TC-22) — never disturbs a campaign already using it. */
  @IsOptional()
  @IsIn(REWARD_STATUSES)
  status?: RewardStatusValue;
}
