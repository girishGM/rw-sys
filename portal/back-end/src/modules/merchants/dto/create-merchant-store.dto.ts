/**
 * T-036 — `POST /merchants/:id/stores` (TC-12/TC-13).
 *
 * No `tenantId`/`merchantId` here — both come from the URL and the actor's own scope
 * (`:id` is resolved against a scoped `Merchant` lookup before this DTO's values are ever
 * written, `merchants.service.ts#createStore`'s own header explains), never from the body.
 */
import {
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  MERCHANT_STORE_ADDRESS_MAX_LENGTH,
  MERCHANT_STORE_CITY_MAX_LENGTH,
  MERCHANT_STORE_CODE_MAX_LENGTH,
  MERCHANT_STORE_NAME_MAX_LENGTH,
  MERCHANT_STORE_POSTAL_CODE_MAX_LENGTH,
  MERCHANT_STORE_REGION_MAX_LENGTH,
  MERCHANT_STORE_STATE_MAX_LENGTH,
} from '../merchants.constants';

export class CreateMerchantStoreDto {
  /** `varchar(50)`, `uq_ms_tenant_code` scoped to `(tenant_id, store_code)`. */
  @IsString()
  @MinLength(1)
  @MaxLength(MERCHANT_STORE_CODE_MAX_LENGTH)
  storeCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MERCHANT_STORE_NAME_MAX_LENGTH)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MERCHANT_STORE_ADDRESS_MAX_LENGTH)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MERCHANT_STORE_CITY_MAX_LENGTH)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MERCHANT_STORE_STATE_MAX_LENGTH)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MERCHANT_STORE_POSTAL_CODE_MAX_LENGTH)
  postalCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MERCHANT_STORE_REGION_MAX_LENGTH)
  region?: string;

  /** `decimal(10,7)`. `class-validator`'s built-in latitude/longitude checks accept either a
   * `number` or a numeric string; a `number` is what this API's JSON body carries. */
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @IsLongitude()
  longitude?: number;
}
