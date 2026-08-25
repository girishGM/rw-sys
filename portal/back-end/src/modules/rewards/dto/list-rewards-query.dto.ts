/**
 * T-032 — `GET /rewards` query params. 03-API-CONTRACT.md §1:
 * `?page=1&pageSize=20&sort=createdAt:desc` — `pageSize` capped at 100, explicit whitelisted
 * params only (no generic query DSL from the client — AGENT-PROTOCOL R2/R3's spirit applied to
 * filtering too). `countryId` is deliberately **not** a filter here: read visibility is decided
 * entirely by the actor's own scope (`ScopedRepository`/`scope-strategy.ts`'s `RewardSystem`
 * entry), never by a client-supplied country id (R3).
 */
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
import { REWARD_STATUSES, type RewardStatusValue } from '../rewards.constants';

/** Columns a caller may sort `/rewards` by. Whitelisted, not "whatever the DTO's key is". */
export const REWARD_SORT_FIELDS = ['systemCode', 'name', 'createdAt', 'status'] as const;
export type RewardSortField = (typeof REWARD_SORT_FIELDS)[number];
export const REWARD_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type RewardSortDirection = (typeof REWARD_SORT_DIRECTIONS)[number];

export class ListRewardsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** No `@Max` here on purpose — the service **caps** an over-large request rather than
   * rejecting it, same as `list-rules-query.dto.ts`. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;

  @IsOptional()
  @IsIn(REWARD_STATUSES)
  status?: RewardStatusValue;

  /** `field:direction`, e.g. `createdAt:desc`. Anything else is a 400, not a best-effort guess. */
  @IsOptional()
  @IsIn(
    REWARD_SORT_FIELDS.flatMap((field) => REWARD_SORT_DIRECTIONS.map((dir) => `${field}:${dir}`)),
  )
  sort?: string;
}
