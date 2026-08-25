/**
 * T-030 — `GET /countries` query params. 03-API-CONTRACT.md §1:
 * `?page=1&pageSize=20&sort=createdAt:desc` — `pageSize` capped at 100, explicit whitelisted
 * params only (no generic query DSL from the client — AGENT-PROTOCOL R2/R3's spirit applied to
 * filtering too).
 */
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

/** Columns a caller may sort `/countries` by. Whitelisted, not "whatever the DTO's key is". */
export const COUNTRY_SORT_FIELDS = ['code', 'name', 'createdAt', 'status'] as const;
export type CountrySortField = (typeof COUNTRY_SORT_FIELDS)[number];
export const COUNTRY_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type CountrySortDirection = (typeof COUNTRY_SORT_DIRECTIONS)[number];

export class ListCountriesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /**
   * No `@Max` here on purpose: the service **caps** an over-large request at
   * `MAX_PAGE_SIZE` rather than rejecting it (03-API-CONTRACT.md §1's literal wording is
   * "capped", not "rejected") — see `countries.service.ts#resolvePagination`.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;

  /** `field:direction`, e.g. `createdAt:desc`. Anything else is a 400, not a best-effort guess. */
  @IsOptional()
  @IsIn(
    COUNTRY_SORT_FIELDS.flatMap((field) => COUNTRY_SORT_DIRECTIONS.map((dir) => `${field}:${dir}`)),
  )
  sort?: string;
}
