/**
 * T-035 — `GET /users` query params. Same shape `list-tenants-query.dto.ts` establishes:
 * `?page=1&pageSize=20&sort=displayName:asc`, `pageSize` capped (not rejected) at 100, explicit
 * whitelisted sort fields only.
 */
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

export const USER_SORT_FIELDS = ['displayName', 'email', 'role', 'status', 'createdAt'] as const;
export type UserSortField = (typeof USER_SORT_FIELDS)[number];
export const USER_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type UserSortDirection = (typeof USER_SORT_DIRECTIONS)[number];

export class ListUsersQueryDto {
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
  @IsIn(USER_SORT_FIELDS.flatMap((field) => USER_SORT_DIRECTIONS.map((dir) => `${field}:${dir}`)))
  sort?: string;
}
