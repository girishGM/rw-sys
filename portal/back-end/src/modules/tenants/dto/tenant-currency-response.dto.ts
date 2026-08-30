/**
 * T-126 — the response bodies `/tenants/:id/currencies` returns. Built by hand from the model
 * instance, never by spreading a Sequelize row — the same construction rule
 * `tenant-response.dto.ts`'s own header records.
 */
import type { TenantCurrency } from '@/database/models/tenant-currency.model';
import type { TenantCurrencyStatusValue } from '../tenants.constants';

export interface TenantCurrencyDto {
  readonly id: number;
  readonly tenantId: number;
  readonly currencyCode: string;
  readonly isDefault: boolean;
  readonly status: TenantCurrencyStatusValue;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toTenantCurrencyDto(row: TenantCurrency): TenantCurrencyDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    currencyCode: row.currencyCode,
    isDefault: row.isDefault,
    status: row.status as TenantCurrencyStatusValue,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
