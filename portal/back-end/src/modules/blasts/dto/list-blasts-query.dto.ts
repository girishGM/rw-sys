/**
 * T-041 — `GET /blasts` query params. Explicit whitelisted params only, same discipline
 * `list-rules-query.dto.ts` documents. `countryId` is deliberately **not** a filter — a
 * `country_admin`'s visibility is already narrowed to their own country by `ScopedRepository`
 * (`VersionBlastTarget`'s scope-strategy entry), never by a client-supplied value (R3).
 */
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
import { VERSION_ENTITY_TYPES } from '../blasts.constants';

export class ListBlastsQueryDto {
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
  @IsIn(VERSION_ENTITY_TYPES)
  entityType?: 'rule' | 'reward';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  entityId?: number;
}
