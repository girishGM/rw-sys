/**
 * T-126 — `POST /tenants/:id/currencies`. `super_admin` only (`assertRole` in
 * `tenant-currencies.service.ts`, independent of the `tenant_currency:create` permission row).
 *
 * `currencyCode` is upper-cased before validation — the same `@Transform`-runs-before-
 * `class-validator` trick `create-tenant.dto.ts`'s own `upperCase` helper documents — so `"myr"`
 * and `"MYR"` both validate and both store as `"MYR"`.
 */
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

/** A local copy, not an import from `create-tenant.dto.ts` — both files already duplicate this
 * exact helper (that file's own header explains why: this task does not import across another
 * task's file, and here it is the same module, but the smallest, most explicit copy is still
 * cheaper than a shared import for a three-line pure function). */
function upperCase({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

export class CreateTenantCurrencyDto {
  /** `char(3)`, `uq_tc_tenant_currency (tenant_id, currency_code)`. */
  @Transform(upperCase)
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currencyCode!: string;

  /** Defaults to `false` — a tenant's default currency is set explicitly, never implied by the
   * order rows happen to be created in. Rejected outright by `uq_tc_one_default` if this tenant
   * already has one (T-126 TC-3). */
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
