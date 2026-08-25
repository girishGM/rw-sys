/**
 * T-036 — `POST /merchants`.
 *
 * No `tenantId` here, on purpose — the same implementation note 2 / AGENT-PROTOCOL R3 shape
 * `create-tenant.dto.ts` documents: `tenant_id` is taken from the actor's own scope, never from
 * the request body. `MerchantsService.create` never reads a tenant id off this DTO;
 * `ScopedRepository.create` forces `tenantId` from the actor's own scope onto the row regardless
 * of what a hand-crafted body might contain (`scope-strategy.ts`'s `Merchant` entry:
 * `tenant: column('tenantId', 'tenant')`) — TC-2.
 *
 * `countryCode` *is* on this DTO, unlike `tenantId` — implementation note 3 requires it to be
 * present and then validated against the tenant's own country, rather than silently derived,
 * because `merchants.country_code` is a plain column with no FK back to `countries` for the
 * service to derive it from authoritatively any other way. `MerchantsService.create` re-verifies
 * it against a scoped lookup of the actor's own tenant before it is trusted (TC-5).
 */
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  MERCHANT_CODE_MAX_LENGTH,
  MERCHANT_CONTACT_EMAIL_MAX_LENGTH,
  MERCHANT_CONTACT_PHONE_MAX_LENGTH,
  MERCHANT_COUNTRY_CODE_LENGTH,
  MERCHANT_DESCRIPTION_MAX_LENGTH,
  MERCHANT_NAME_MAX_LENGTH,
  MERCHANT_WEBSITE_MAX_LENGTH,
} from '../merchants.constants';

/** Upper-cases a string value; passes anything else through unchanged — the same local copy
 * `create-tenant.dto.ts`'s own header explains: this task does not import across
 * `countries/**`/`tenants/**`, another task's file scope. */
function upperCase({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

export class CreateMerchantDto {
  /** `varchar(50)`, `uq_m_tenant_code` scoped to `(tenant_id, merchant_code)` (TC-3/TC-4). A
   * conservative charset, the same caution `create-tenant.dto.ts#code` documents. */
  @IsString()
  @MinLength(1)
  @MaxLength(MERCHANT_CODE_MAX_LENGTH)
  @Matches(/^[A-Za-z0-9_-]+$/)
  merchantCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MERCHANT_NAME_MAX_LENGTH)
  name!: string;

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

  /** `char(2)` — implementation note 3: must match the actor's tenant's own country (TC-5). */
  @Transform(upperCase)
  @IsString()
  @Length(MERCHANT_COUNTRY_CODE_LENGTH, MERCHANT_COUNTRY_CODE_LENGTH)
  @Matches(/^[A-Z]{2}$/)
  countryCode!: string;
}
