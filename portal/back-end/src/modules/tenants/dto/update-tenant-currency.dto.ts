/**
 * T-126 — `PATCH /tenants/:id/currencies/:currencyId`. `super_admin` only.
 *
 * `currencyCode` is never here — immutable once created, the same discipline
 * `update-rule-category.dto.ts` applies to `categoryCode` (T-106's own precedent: a business key
 * is write-once). `status` is the "retire a currency" lever, matching that same precedent's
 * "status toggling to inactive covers the retire case" rather than a `DELETE` endpoint.
 */
import { IsIn, IsOptional } from 'class-validator';
import { TENANT_CURRENCY_STATUSES, type TenantCurrencyStatusValue } from '../tenants.constants';

export class UpdateTenantCurrencyDto {
  @IsOptional()
  @IsIn(TENANT_CURRENCY_STATUSES)
  status?: TenantCurrencyStatusValue;
}
