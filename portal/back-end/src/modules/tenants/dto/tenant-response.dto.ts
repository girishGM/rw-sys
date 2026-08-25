/**
 * T-034 — the response bodies `/tenants` returns, and the only shapes it may return.
 *
 * Built by hand from the model instances the service loads, never by spreading a Sequelize row
 * — the same construction rule `countries/dto/country-response.dto.ts` records, for the same
 * reason: no internal id beyond what the UI needs, no credential field, ever, as a property of
 * the code rather than of somebody remembering to strip a column.
 */
import type { Tenant } from '@/database/models/tenant.model';
import type { TenantBudgetCeiling } from '@/database/models/tenant-budget-ceiling.model';
import type { TenantBudgetCeilingUnitType, TenantStatusValue } from '../tenants.constants';

/** 03-API-CONTRACT.md §1 — `{ "data": … }`. Declared locally per the precedent
 * `country-response.dto.ts` documents: this envelope is an API-wide convention no task owns a
 * shared home for. */
export interface DataEnvelope<T> {
  readonly data: T;
}

export function envelope<T>(data: T): DataEnvelope<T> {
  return { data };
}

export interface ListMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface DataListEnvelope<T> {
  readonly data: readonly T[];
  readonly meta: ListMeta;
}

export interface TenantDto {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly countryId: number;
  readonly schemaPrefix: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly status: TenantStatusValue;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toTenantDto(tenant: Tenant): TenantDto {
  return {
    id: tenant.id,
    code: tenant.code,
    name: tenant.name,
    countryId: tenant.countryId,
    schemaPrefix: tenant.schemaPrefix,
    contactEmail: tenant.contactEmail,
    contactPhone: tenant.contactPhone,
    status: tenant.status as TenantStatusValue,
    createdAt: tenant.createdAt.toISOString(),
    updatedAt: tenant.updatedAt.toISOString(),
  };
}

/**
 * The one-time credential response — `POST /tenants/:id/admins`, and the `admin` field of
 * `POST /tenants` when `admin` was supplied (BACKLOG.md B-01).
 *
 * `temporaryPassword` is the plaintext, deliberately: generated once, returned once, never
 * stored anywhere this DTO could later read it back from (T-046 owns the general reveal
 * mechanism this pattern anticipates).
 */
export interface TenantAdminCreatedDto {
  readonly id: number;
  readonly email: string;
  readonly displayName: string;
  readonly role: 'tenant_admin';
  readonly tenantId: number;
  readonly temporaryPassword: string;
}

export interface CreateTenantResultDto {
  readonly tenant: TenantDto;
  readonly admin: TenantAdminCreatedDto | null;
}

/** One `tenant_budget_ceilings` row — `GET`/`PUT /tenants/:id/budget-ceilings`. */
export interface BudgetCeilingDto {
  readonly id: number;
  readonly tenantId: number;
  readonly unitType: TenantBudgetCeilingUnitType;
  readonly unitCode: string;
  readonly maxCampaignBudget: string;
  readonly warnAboveAmount: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toBudgetCeilingDto(row: TenantBudgetCeiling): BudgetCeilingDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    unitType: row.unitType as TenantBudgetCeilingUnitType,
    unitCode: row.unitCode,
    maxCampaignBudget: row.maxCampaignBudget,
    warnAboveAmount: row.warnAboveAmount,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** One row of the "tenants without a budget ceiling" dashboard widget (implementation note 7,
 * TC-28) — deliberately a small subset of {@link TenantDto}, matching what the widget shows. */
export interface TenantWithoutCeilingDto {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly countryId: number;
}

export function toTenantWithoutCeilingDto(tenant: Tenant): TenantWithoutCeilingDto {
  return { id: tenant.id, code: tenant.code, name: tenant.name, countryId: tenant.countryId };
}
