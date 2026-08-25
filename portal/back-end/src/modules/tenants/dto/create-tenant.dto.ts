/**
 * T-034 — `POST /tenants`.
 *
 * No `countryId` here, on purpose — implementation note 2: *"`country_id` is taken from the
 * actor's scope, never from the request body. A `country_id` in a DTO is a bug (AGENT-PROTOCOL
 * R3) — it is the direct path to a country admin creating a tenant in someone else's country."*
 * `TenantsService.create` never reads a country id off this DTO; `ScopedRepository.create`
 * forces `countryId` from the actor's own scope onto the row regardless of what a hand-crafted
 * body might contain (`scope-strategy.ts`'s `Tenant` entry: `country: column('countryId',
 * 'country')`) — the same two-independent-layers shape R3's own sentence asks for.
 *
 * `code` is upper-cased before validation, the same `@Transform`-runs-before-`class-validator`
 * trick `create-country.dto.ts` uses, so `"t001"` and `"T001"` both validate and both store as
 * `"T001"`.
 *
 * `admin` is optional: supplying it makes tenant + Tenant Admin creation one transaction
 * (implementation note 5); omitting it creates the tenant alone, with `POST
 * /tenants/:id/admins` available afterwards for the same onboarding step.
 */
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  TENANT_CODE_MAX_LENGTH,
  TENANT_CONTACT_EMAIL_MAX_LENGTH,
  TENANT_CONTACT_PHONE_MAX_LENGTH,
  TENANT_NAME_MAX_LENGTH,
} from '../tenants.constants';
import { IsTenantSchemaPrefix } from './tenant-validators.decorators';
import { CreateTenantAdminDto } from './create-tenant-admin.dto';

/** Upper-cases a string value; passes anything else through unchanged, the same as
 * `create-country.dto.ts`'s own `upperCase` helper (a local copy — see this file's own header
 * for why T-034 does not import across `countries/**`, another task's file scope). */
function upperCase({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

export class CreateTenantDto {
  /** `varchar(20)`, `uq_tenants_code` (TC-10). Uppercase alphanumerics, `-`/`_` allowed — the
   * same "reaches SQL identifiers downstream" caution implementation note 4 states for
   * `schemaPrefix` does not apply here (`code` is a display/business key, never an identifier),
   * but a conservative charset is still cheaper than debugging a stray character later. */
  @Transform(upperCase)
  @IsString()
  @MinLength(1)
  @MaxLength(TENANT_CODE_MAX_LENGTH)
  @Matches(/^[A-Z0-9_-]+$/)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(TENANT_NAME_MAX_LENGTH)
  name!: string;

  /** `varchar(10)`, `uq_tenants_schema_prefix`, nullable — omit entirely for "no prefix yet"
   * (TC-11, TC-12). Implementation note 4: `^[a-z][a-z0-9_]{0,9}$` — "it may reach SQL
   * identifiers downstream". */
  @IsOptional()
  @IsString()
  @IsTenantSchemaPrefix()
  schemaPrefix?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(TENANT_CONTACT_EMAIL_MAX_LENGTH)
  contactEmail?: string;

  /** `varchar(20)` — an optional leading `+` and up to 19 digits. */
  @IsOptional()
  @IsString()
  @MaxLength(TENANT_CONTACT_PHONE_MAX_LENGTH)
  @Matches(/^\+?[0-9]{1,19}$/)
  contactPhone?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateTenantAdminDto)
  admin?: CreateTenantAdminDto;
}
