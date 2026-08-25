/**
 * T-036 — `PATCH /merchants/:id`.
 *
 * Every field is optional (a partial update), except that the *set* of allowed names is fixed —
 * the same whitelist discipline `update-tenant.dto.ts` documents: an undeclared key is a 400
 * (`forbidNonWhitelisted`) under the global `ValidationPipe`. `merchantCode`, `tenantId` and
 * `countryCode` are never in this whitelist: `merchantCode` is an immutable business key (same
 * convention as `tenant.code`), `tenantId` must never be settable from a request body at all
 * (AGENT-PROTOCOL R3), and `countryCode` was already validated against the tenant's own country
 * at creation time — moving a merchant between countries, if it is ever a legitimate operation,
 * is a decision for the architect, not a side effect of a generic PATCH.
 *
 * `confirm` — implementation note 7 (TC-20): required to deactivate (`status` away from
 * `active`) a merchant that participates in an active campaign. Same shape
 * `update-country.dto.ts#confirm` establishes.
 */
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  MERCHANT_CONTACT_EMAIL_MAX_LENGTH,
  MERCHANT_CONTACT_PHONE_MAX_LENGTH,
  MERCHANT_DESCRIPTION_MAX_LENGTH,
  MERCHANT_NAME_MAX_LENGTH,
  MERCHANT_STATUSES,
  MERCHANT_WEBSITE_MAX_LENGTH,
  type MerchantStatusValue,
} from '../merchants.constants';

export class UpdateMerchantDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MERCHANT_NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MERCHANT_DESCRIPTION_MAX_LENGTH)
  description?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(MERCHANT_CONTACT_EMAIL_MAX_LENGTH)
  contactEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MERCHANT_CONTACT_PHONE_MAX_LENGTH)
  @Matches(/^\+?[0-9]{1,19}$/)
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MERCHANT_WEBSITE_MAX_LENGTH)
  website?: string;

  @IsOptional()
  @IsIn(MERCHANT_STATUSES)
  status?: MerchantStatusValue;

  /** Implementation note 7 — required to deactivate a merchant with active campaigns (TC-20). */
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}
