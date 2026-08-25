/**
 * T-041 — `POST /blasts`. `super_admin` only. The `scope`/`countryIds` combination is checked
 * in `BlastsService`, not here (`InvalidCountrySelectionError`) — the same split
 * `assign-rule-country.dto.ts` vs `RulesService` draws between shape validation and a business
 * rule about the value.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { BLAST_NOTE_MAX_LENGTH, BLAST_SCOPES, VERSION_ENTITY_TYPES } from '../blasts.constants';

export class CreateBlastDto {
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

  @IsOptional()
  @IsString()
  @MaxLength(BLAST_NOTE_MAX_LENGTH)
  note?: string;

  @IsOptional()
  @IsInt()
  originRequestId?: number;

  /** Required (`true`) when the target version's `isBreaking` is `true` (implementation
   * note 9). */
  @IsOptional()
  @IsBoolean()
  confirmBreaking?: boolean;
}
