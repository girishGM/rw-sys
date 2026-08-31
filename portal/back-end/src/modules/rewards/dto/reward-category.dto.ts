/**
 * T-116 — `POST`/`PATCH /reward-categories`, `/reward-sub-categories`. `super_admin` only.
 * Mirrors `create-rule-category.dto.ts`/`update-rule-category.dto.ts` (T-106) exactly — `status`
 * is never accepted on create (a new row is always `active`), and `categoryCode`/
 * `subCategoryCode`/`categoryId` are all write-once (never accepted on update).
 */
import { IsIn, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import {
  REWARD_CATEGORY_CODE_MAX_LENGTH,
  REWARD_CATEGORY_NAME_MAX_LENGTH,
  REWARD_STATUSES,
} from '../rewards.constants';

export class CreateRewardCategoryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(REWARD_CATEGORY_CODE_MAX_LENGTH)
  categoryCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(REWARD_CATEGORY_NAME_MAX_LENGTH)
  name!: string;
}

/** `categoryCode` is immutable once created — never accepted here. */
export class UpdateRewardCategoryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(REWARD_CATEGORY_NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @IsIn(REWARD_STATUSES)
  status?: string;
}

/** `categoryId` is required and write-once — moving a sub-category to a different category
 * later is out of scope (same discipline `create-rule-sub-category.dto.ts` documents). */
export class CreateRewardSubCategoryDto {
  @IsInt()
  categoryId!: number;

  @IsString()
  @MinLength(2)
  @MaxLength(REWARD_CATEGORY_CODE_MAX_LENGTH)
  subCategoryCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(REWARD_CATEGORY_NAME_MAX_LENGTH)
  name!: string;
}

/** `subCategoryCode`/`categoryId` are immutable once created — neither is accepted here. */
export class UpdateRewardSubCategoryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(REWARD_CATEGORY_NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @IsIn(REWARD_STATUSES)
  status?: string;
}
