/**
 * T-040 — `GET /notifications` query params. 03-API-CONTRACT.md §1: `?page=1&pageSize=20`,
 * `pageSize` capped (not rejected) at {@link NOTIFICATION_MAX_PAGE_SIZE}. No `sort`/filter
 * params: unlike the audit viewer, the feed has exactly one order (newest first) and exactly
 * one scope (the caller's own), so there is nothing here for a client to whitelist against —
 * see `list-audit-query.dto.ts` in the sibling `audit` module for the shape this takes once a
 * screen actually needs filtering.
 */
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

export class ListNotificationsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}
