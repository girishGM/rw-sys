/**
 * T-031 — the response bodies `/rules` returns, and the only shapes it may return.
 *
 * Built by hand from the `RuleMaster`/`RuleSubCategory`/`RuleCategory`/`RuleCountryAssignment`/
 * `Country` model instances the service loads, never by spreading a Sequelize row — the same
 * construction rule `country-response.dto.ts` records, for the same reason. Mirrored
 * field-for-field by `packages/shared/src/rule.schema.ts`.
 */
import type { RuleMaster } from '@/database/models/rule-master.model';
import type { RuleCategory } from '@/database/models/rule-category.model';
import type { RuleSubCategory } from '@/database/models/rule-sub-category.model';
import type { RuleCountryAssignment } from '@/database/models/rule-country-assignment.model';
import type { Country } from '@/database/models/country.model';
import type { RuleStatusValue } from '../rules.constants';

/** 03-API-CONTRACT.md §1 — `{ "data": … }`. Declared locally per the precedent `countries`'s
 * own copy documents: this envelope is an API-wide convention no task owns a shared home for. */
export interface DataEnvelope<T> {
  readonly data: T;
}

export function envelope<T>(data: T): DataEnvelope<T> {
  return { data };
}

export interface ListMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface DataListEnvelope<T> {
  readonly data: readonly T[];
  readonly meta: ListMeta;
}

/** A rule with its sub-category (and the sub-category's own category) eagerly loaded — the
 * shape every read path in this module loads it in, so `toRuleDto` never has to guard against
 * a missing association. */
export type RuleWithCategory = RuleMaster & {
  subCategory: RuleSubCategory & { category: RuleCategory };
};

export interface RuleDto {
  readonly id: number;
  readonly ruleCode: string;
  readonly name: string;
  readonly categoryId: number;
  readonly categoryName: string;
  readonly subCategoryId: number;
  readonly subCategoryName: string;
  readonly expression: string | null;
  readonly parameters: Record<string, unknown>;
  readonly status: RuleStatusValue;
  readonly createdBy: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toRuleDto(rule: RuleWithCategory): RuleDto {
  return {
    id: rule.id,
    ruleCode: rule.ruleCode,
    name: rule.name,
    categoryId: rule.subCategory.category.id,
    categoryName: rule.subCategory.category.name,
    subCategoryId: rule.subCategoryId,
    subCategoryName: rule.subCategory.name,
    expression: rule.expression,
    parameters: rule.parameters,
    status: rule.status as RuleStatusValue,
    createdBy: rule.createdBy,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

/** `GET /rules/:id/parameters` (TC-15) — the parsed schema alone, not the whole rule.
 * `rule.parameters`'s getter (`rule-master.model.ts`) already parses the `text` column —
 * tolerantly, returning `{}` for malformed content rather than throwing. */
export function toRuleParametersDto(rule: RuleMaster): Record<string, unknown> {
  return rule.parameters;
}

export interface RuleCountryAssignmentDto {
  readonly id: number;
  readonly ruleId: number;
  readonly countryId: number;
  readonly countryCode: string;
  readonly countryName: string;
  readonly assignedAt: string;
  readonly assignedBy: number | null;
}

export function toRuleCountryAssignmentDto(
  assignment: RuleCountryAssignment & { country: Country },
): RuleCountryAssignmentDto {
  return {
    id: assignment.id,
    ruleId: assignment.ruleId,
    countryId: assignment.countryId,
    countryCode: assignment.country.code,
    countryName: assignment.country.name,
    assignedAt: assignment.assignedAt.toISOString(),
    assignedBy: assignment.assignedBy,
  };
}

export interface RuleCategoryDto {
  readonly id: number;
  readonly categoryCode: string;
  readonly name: string;
  readonly status: string;
}

export function toRuleCategoryDto(category: RuleCategory): RuleCategoryDto {
  return {
    id: category.id,
    categoryCode: category.categoryCode,
    name: category.name,
    status: category.status,
  };
}

export interface RuleSubCategoryDto {
  readonly id: number;
  readonly categoryId: number;
  readonly subCategoryCode: string;
  readonly name: string;
  readonly status: string;
}

export function toRuleSubCategoryDto(subCategory: RuleSubCategory): RuleSubCategoryDto {
  return {
    id: subCategory.id,
    categoryId: subCategory.categoryId,
    subCategoryCode: subCategory.subCategoryCode,
    name: subCategory.name,
    status: subCategory.status,
  };
}
