/**
 * T-030 — `PATCH /countries/:id`.
 *
 * Every field is optional (a partial update), except that the *set* of allowed names is fixed —
 * the same whitelist discipline `me-request.dto.ts` documents: an undeclared key is a 400
 * (`forbidNonWhitelisted`) under the global `ValidationPipe`, never a silently dropped or
 * silently honoured one. `id` in the body (TC-17) is exactly such a key.
 */
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Matches,
  MinLength,
} from 'class-validator';
import {
  COUNTRY_CURRENCY_CODE_LENGTH,
  COUNTRY_DIALING_CODE_MAX_LENGTH,
  COUNTRY_NAME_MAX_LENGTH,
  COUNTRY_STATUSES,
  COUNTRY_TIMEZONE_MAX_LENGTH,
  type CountryStatusValue,
} from '../countries.constants';
import { IsCurrencyCode, IsTimeZone } from './country-validators.decorators';

function upperCase({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

export class UpdateCountryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(COUNTRY_NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(COUNTRY_TIMEZONE_MAX_LENGTH)
  @IsTimeZone()
  timezone?: string;

  @IsOptional()
  @Transform(upperCase)
  @IsString()
  @Length(COUNTRY_CURRENCY_CODE_LENGTH, COUNTRY_CURRENCY_CODE_LENGTH)
  @IsCurrencyCode()
  currencyCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(COUNTRY_DIALING_CODE_MAX_LENGTH)
  @Matches(/^\+?[0-9]{1,4}$/)
  dialingCode?: string;

  @IsOptional()
  @IsBoolean()
  isHq?: boolean;

  @IsOptional()
  @IsIn(COUNTRY_STATUSES)
  status?: CountryStatusValue;

  /** T-030 implementation note 7 — required to deactivate a country with active tenants. */
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}
