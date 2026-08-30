/**
 * T-031 — `GET /rules` query params. 03-API-CONTRACT.md §1:
 * `?page=1&pageSize=20&sort=createdAt:desc` — `pageSize` capped at 100, explicit whitelisted
 * params only (no generic query DSL from the client — AGENT-PROTOCOL R2/R3's spirit applied to
 * filtering too). `countryId` is deliberately **not** a filter here: read visibility is decided
 * entirely by the actor's own scope (`ScopedRepository`/`scope-strategy.ts`'s `RuleMaster`
 * entry), never by a client-supplied country id (R3).
 *
 * T-111 — `categoryId`/`subCategoryId`/`search` added so a growing rule catalogue can be
 * narrowed without scrolling a flat, unfiltered list. Same shape `list-merchants-query.dto.ts`
 * establishes for `search` (TC-21 there): a plain-text term matched server-side, never a query
 * DSL. `categoryId`/`subCategoryId` are reference-data ids, not a scope value — they narrow
 * *which* rules show up inside whatever the actor's own scope already permits, exactly like
 * `status` above; they carry no authority of their own (R3 still governs visibility).
 */
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { RULE_SEARCH_MAX_LENGTH, RULE_STATUSES, type RuleStatusValue } from '../rules.constants';

/** Columns a caller may sort `/rules` by. Whitelisted, not "whatever the DTO's key is". */
export const RULE_SORT_FIELDS = ['ruleCode', 'name', 'createdAt', 'status'] as const;
export type RuleSortField = (typeof RULE_SORT_FIELDS)[number];
export const RULE_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type RuleSortDirection = (typeof RULE_SORT_DIRECTIONS)[number];

export class ListRulesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** No `@Max` here on purpose — the service **caps** an over-large request rather than
   * rejecting it, same as `list-countries-query.dto.ts`. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;

  @IsOptional()
  @IsIn(RULE_STATUSES)
  status?: RuleStatusValue;

  /** `field:direction`, e.g. `createdAt:desc`. Anything else is a 400, not a best-effort guess. */
  @IsOptional()
  @IsIn(RULE_SORT_FIELDS.flatMap((field) => RULE_SORT_DIRECTIONS.map((dir) => `${field}:${dir}`)))
  sort?: string;

  /** T-111 — rules whose sub-category rolls up to this category. Resolved to a set of
   * `subCategoryId`s by the service; a bogus/out-of-scope id simply matches nothing (same "empty
   * result, not an error" shape every other reference-data filter in this module already has). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  categoryId?: number;

  /** T-111 — exact `rule_master.sub_category_id` match. Takes precedence over `categoryId` when
   * both are supplied (the more specific ask wins). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  subCategoryId?: number;

  /** T-111 — `ruleCode`/`name`, case-insensitive, same shape `list-merchants-query.dto.ts`'s own
   * `search` (TC-21). */
  @IsOptional()
  @IsString()
  @MaxLength(RULE_SEARCH_MAX_LENGTH)
  search?: string;
}
