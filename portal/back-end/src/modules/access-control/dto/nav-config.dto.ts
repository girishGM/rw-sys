/**
 * T-033 — `GET`/`PUT /admin/access-control/nav/:role` (03-API-CONTRACT.md §4).
 *
 * `PUT` is a **full replace** of the role's `role_nav_configs` rows (implementation note 5): the
 * body is the complete set of nav items the role should have afterwards, not a delta. `navKey`
 * doubles as each item's identity across the diff the service computes.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** `role_nav_configs.nav_key` — an identifier, not free text, because it is also the tree's
 * parent/child link (`parentNavKey`) and this module's diff key. */
const NAV_KEY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

export class NavConfigItemDto {
  @IsString()
  @Matches(NAV_KEY_PATTERN, { message: 'navKey must be lower_snake_case, starting with a letter' })
  navKey!: string;

  @IsString()
  @MinLength(1)
  label!: string;

  @IsOptional()
  @IsString()
  icon?: string | null;

  @IsString()
  @MinLength(1)
  path!: string;

  @IsOptional()
  @IsString()
  parentNavKey?: string | null;

  @IsInt()
  @Min(0)
  sortOrder!: number;

  @IsBoolean()
  enabled!: boolean;
}

export class PutNavConfigDto {
  /** The `rbac_version:<role>` the caller last read (TC-22 — optimistic concurrency). */
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => NavConfigItemDto)
  items!: NavConfigItemDto[];
}
