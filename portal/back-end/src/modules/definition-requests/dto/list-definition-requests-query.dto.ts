/**
 * T-042 — `GET /definition-requests` query params (TC-21: "paginated; filterable by status and
 * priority"). `pageSize` capped, not rejected, at 100 (03-API-CONTRACT.md §1) — same shape as
 * `list-rules-query.dto.ts`. No `countryId`/`tenantId` filter here on purpose: read visibility
 * is decided entirely by the actor's own scope (`ScopedRepository`/`scope-strategy.ts`'s
 * `DefinitionRequest` entry), never by a client-supplied scope id (R3).
 */
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
import {
  DEFINITION_REQUEST_PRIORITIES,
  DEFINITION_REQUEST_STATUSES,
  type DefinitionRequestPriorityValue,
  type DefinitionRequestStatusValue,
} from '../definition-requests.constants';

export class ListDefinitionRequestsQueryDto {
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

  @IsOptional()
  @IsIn(DEFINITION_REQUEST_STATUSES)
  status?: DefinitionRequestStatusValue;

  @IsOptional()
  @IsIn(DEFINITION_REQUEST_PRIORITIES)
  priority?: DefinitionRequestPriorityValue;
}
