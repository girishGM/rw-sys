/**
 * T-041 — `POST /blasts/preview`. `super_admin` only, no writes (implementation note 6). Same
 * shape as `CreateBlastDto` minus the audit-only fields (`note`/`originRequestId`) and the
 * confirmation flag, which have no meaning for a read-only preview.
 */
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional } from 'class-validator';
import { BLAST_SCOPES, VERSION_ENTITY_TYPES } from '../blasts.constants';

export class PreviewBlastDto {
  @IsIn(VERSION_ENTITY_TYPES)
  entityType!: 'rule' | 'reward';

  @IsInt()
  entityId!: number;

  @IsInt()
  versionId!: number;

  @IsIn(BLAST_SCOPES)
  scope!: 'all_countries' | 'selected';

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(300)
  @Type(() => Number)
  @IsInt({ each: true })
  countryIds?: number[];
}
