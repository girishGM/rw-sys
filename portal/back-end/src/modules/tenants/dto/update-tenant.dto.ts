/**
 * T-034 — `PATCH /tenants/:id`.
 *
 * Every field is optional (a partial update), except that the *set* of allowed names is fixed —
 * the same whitelist discipline `update-country.dto.ts` documents: an undeclared key is a 400
 * (`forbidNonWhitelisted`) under the global `ValidationPipe`, never a silently dropped or
 * silently honoured one. `code` and `countryId` are never in this whitelist: `code` is an
 * immutable business key (same convention as `country.code`), and `countryId` must never be
 * settable from a request body at all (AGENT-PROTOCOL R3) — moving a tenant between countries,
 * if it is ever a legitimate operation, is a decision for the architect, not a side effect of a
 * generic PATCH.
 *
 * `status` carries all four `ck_tenants_status` values, including `suspended` — unlike
 * `update-country.dto.ts`'s two-value enum. Setting it to anything other than `active` is what
 * `TenantsService.update` treats as a suspension for the purposes of implementation note 8's
 * session revocation (see that method's own header for exactly which transitions qualify).
 */
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  TENANT_CONTACT_EMAIL_MAX_LENGTH,
  TENANT_CONTACT_PHONE_MAX_LENGTH,
  TENANT_NAME_MAX_LENGTH,
  TENANT_STATUSES,
  type TenantStatusValue,
} from '../tenants.constants';
import { IsTenantSchemaPrefix } from './tenant-validators.decorators';

export class UpdateTenantDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(TENANT_NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @IsString()
  @IsTenantSchemaPrefix()
  schemaPrefix?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(TENANT_CONTACT_EMAIL_MAX_LENGTH)
  contactEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(TENANT_CONTACT_PHONE_MAX_LENGTH)
  @Matches(/^\+?[0-9]{1,19}$/)
  contactPhone?: string;

  @IsOptional()
  @IsIn(TENANT_STATUSES)
  status?: TenantStatusValue;
}
