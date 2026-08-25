/**
 * T-030 — `POST /countries`.
 *
 * `code`/`currencyCode` are upper-cased **before** validation (`@Transform` runs ahead of the
 * `class-validator` decorators under Nest's global `ValidationPipe({ transform: true })`), so
 * `"my"` and `"MY"` are both accepted and both stored as `"MY"` (implementation note 2: "validate
 * ISO-3166-1 alpha-2, store uppercase").
 *
 * `admin` is optional: supplying it makes country + Country Admin creation one transaction
 * (implementation note 5); omitting it creates the country alone, with `POST
 * /countries/:id/admins` available afterwards for the same onboarding step.
 */
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  COUNTRY_CODE_LENGTH,
  COUNTRY_CURRENCY_CODE_LENGTH,
  COUNTRY_DIALING_CODE_MAX_LENGTH,
  COUNTRY_NAME_MAX_LENGTH,
  COUNTRY_TIMEZONE_MAX_LENGTH,
} from '../countries.constants';
import { IsCountryCode, IsCurrencyCode, IsTimeZone } from './country-validators.decorators';
import { CreateCountryAdminDto } from './create-country-admin.dto';

/** Upper-cases a string value; passes anything else through unchanged for `class-validator`
 * to reject on its own terms (`@IsString` reports a clearer error than a `TypeError` here would). */
function upperCase({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

export class CreateCountryDto {
  @Transform(upperCase)
  @IsString()
  @Length(COUNTRY_CODE_LENGTH, COUNTRY_CODE_LENGTH)
  @IsCountryCode()
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(COUNTRY_NAME_MAX_LENGTH)
  name!: string;

  @IsString()
  @MaxLength(COUNTRY_TIMEZONE_MAX_LENGTH)
  @IsTimeZone()
  timezone!: string;

  @Transform(upperCase)
  @IsString()
  @Length(COUNTRY_CURRENCY_CODE_LENGTH, COUNTRY_CURRENCY_CODE_LENGTH)
  @IsCurrencyCode()
  currencyCode!: string;

  /** `+60`, `60`, `1` — an optional leading `+` and 1-4 digits (`dialing_code varchar(5)`). */
  @IsString()
  @MaxLength(COUNTRY_DIALING_CODE_MAX_LENGTH)
  @Matches(/^\+?[0-9]{1,4}$/)
  dialingCode!: string;

  @IsOptional()
  @IsBoolean()
  isHq?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateCountryAdminDto)
  admin?: CreateCountryAdminDto;
}
