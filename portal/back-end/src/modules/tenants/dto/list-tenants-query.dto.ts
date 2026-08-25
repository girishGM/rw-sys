/**
 * T-034 — `GET /tenants` query params. Same shape `list-countries-query.dto.ts` establishes:
 * `?page=1&pageSize=20&sort=name:asc`, `pageSize` capped (not rejected) at 100, explicit
 * whitelisted sort fields only.
 */
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

export const TENANT_SORT_FIELDS = ['code', 'name', 'createdAt', 'status'] as const;
export type TenantSortField = (typeof TENANT_SORT_FIELDS)[number];
export const TENANT_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type TenantSortDirection = (typeof TENANT_SORT_DIRECTIONS)[number];

export class ListTenantsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** No `@Max` — the service **caps** an over-large request at `MAX_PAGE_SIZE` rather than
   * rejecting it (03-API-CONTRACT.md §1: "capped", not "rejected"). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;

  /** `field:direction`, e.g. `createdAt:desc`. Anything else is a 400. */
  @IsOptional()
  @IsIn(
    TENANT_SORT_FIELDS.flatMap((field) => TENANT_SORT_DIRECTIONS.map((dir) => `${field}:${dir}`)),
  )
  sort?: string;
}
