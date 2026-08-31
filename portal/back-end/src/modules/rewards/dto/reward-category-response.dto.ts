/**
 * T-116 — the response bodies `/reward-categories`, `/reward-sub-categories` return. Built by
 * hand from the `RewardCategory`/`RewardSubCategory` model instances the service loads, never by
 * spreading a Sequelize row — the same construction rule `reward-response.dto.ts`/
 * `rule-response.dto.ts` record, for the same reason. Mirrored field-for-field by
 * `packages/shared/src/reward.schema.ts`.
 */
import type { RewardCategory } from '@/database/models/reward-category.model';
import type { RewardSubCategory } from '@/database/models/reward-sub-category.model';

export interface RewardCategoryDto {
  readonly id: number;
  readonly categoryCode: string;
  readonly name: string;
  readonly status: string;
}

export function toRewardCategoryDto(category: RewardCategory): RewardCategoryDto {
  return {
    id: category.id,
    categoryCode: category.categoryCode,
    name: category.name,
    status: category.status,
  };
}

export interface RewardSubCategoryDto {
  readonly id: number;
  readonly categoryId: number;
  readonly subCategoryCode: string;
  readonly name: string;
  readonly status: string;
}

export function toRewardSubCategoryDto(subCategory: RewardSubCategory): RewardSubCategoryDto {
  return {
    id: subCategory.id,
    categoryId: subCategory.categoryId,
    subCategoryCode: subCategory.subCategoryCode,
    name: subCategory.name,
    status: subCategory.status,
  };
}
