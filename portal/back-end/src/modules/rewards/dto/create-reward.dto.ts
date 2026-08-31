/**
 * T-032 — `POST /rewards`. `super_admin` only (all three layers — see `rewards.service.ts`).
 *
 * `tenantId`/`status` are never accepted here (AGENT-PROTOCOL R3/R2): the service always writes
 * `tenant_id = NULL` (01-DATABASE.md §4) and `status = 'active'` on create.
 *
 * `categoryId`/`subCategoryId` — T-118. `categoryId` is required (`reward_systems.category_id`
 * is `NOT NULL`, `T118_001`); `subCategoryId` is optional — a reward category may legitimately
 * have zero sub-categories (T-116's own "Points never needs one" example). The service cross-
 * checks that a supplied `subCategoryId` actually belongs to `categoryId` — see
 * `rewards.service.ts#create`.
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
  REWARD_SYSTEM_CODE_MAX_LENGTH,
  REWARD_TYPE_MAX_LENGTH,
  type RewardConnectorTypeValue,
  type RewardDeliveryModeValue,
} from '../rewards.constants';
import { IsRewardConnectorConfig, IsRewardSystemCode } from './reward-validators.decorators';

export class CreateRewardDto {
  @IsString()
  @MinLength(2)
  @MaxLength(REWARD_SYSTEM_CODE_MAX_LENGTH)
  @IsRewardSystemCode()
  systemCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(REWARD_NAME_MAX_LENGTH)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(REWARD_DESCRIPTION_MAX_LENGTH)
  description?: string;

  /** Deliberately free text, not an enum — 11-BUDGETS-AND-LIMITS.md §3.1 (see
   * `packages/shared/src/reward.schema.ts`'s `rewardTypeSchema` header for the full reasoning). */
  @IsString()
  @MinLength(1)
  @MaxLength(REWARD_TYPE_MAX_LENGTH)
  rewardType!: string;

  @IsOptional()
  @IsIn(REWARD_DELIVERY_MODES)
  deliveryMode?: RewardDeliveryModeValue;

  @IsIn(REWARD_CONNECTOR_TYPES)
  connectorType!: RewardConnectorTypeValue;

  /** May contain third-party credentials — encrypted at rest before it ever reaches a column
   * (implementation note 4, `reward-connector-config.crypto.ts`). */
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
  merchantId?: number;

  @IsInt()
  categoryId!: number;

  @IsOptional()
  @IsInt()
  subCategoryId?: number;
}
