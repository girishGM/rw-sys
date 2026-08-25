/**
 * T-036 — `GET /merchants` query params. Same shape `list-tenants-query.dto.ts` establishes:
 * `?page=1&pageSize=20&sort=name:asc`, `pageSize` capped (not rejected) at 100, explicit
 * whitelisted sort fields only, plus `search` (TC-21) — matched server-side against
 * `merchantCode`/`name`, case-insensitively; scope (never a client-supplied `tenantId`) still
 * decides which rows are even candidates, exactly as it does with no `search` at all.
 */
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { MERCHANT_SEARCH_MAX_LENGTH } from '../merchants.constants';

export const MERCHANT_SORT_FIELDS = ['merchantCode', 'name', 'createdAt', 'status'] as const;
export type MerchantSortField = (typeof MERCHANT_SORT_FIELDS)[number];
export const MERCHANT_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type MerchantSortDirection = (typeof MERCHANT_SORT_DIRECTIONS)[number];

export class ListMerchantsQueryDto {
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
    MERCHANT_SORT_FIELDS.flatMap((field) =>
      MERCHANT_SORT_DIRECTIONS.map((dir) => `${field}:${dir}`),
    ),
  )
  sort?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MERCHANT_SEARCH_MAX_LENGTH)
  search?: string;
}
