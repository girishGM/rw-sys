/**
 * T-030 — the response bodies `/countries` returns, and the only shapes it may return.
 *
 * Built by hand from the `Country`/`Tenant` model instances the service loads, never by
 * spreading a Sequelize row — the same construction rule `bootstrap-response.dto.ts` and
 * `me/dto/bootstrap-response.dto.ts` record, for the same reason: it is what makes TC-16 ("no
 * internal ids beyond what the UI needs; no user credential fields") a property of the code
 * rather than of somebody remembering to strip a column. Mirrored field-for-field by
 * `packages/shared/src/country.schema.ts`.
 */
import type { Country } from '@/database/models/country.model';
import type { Tenant } from '@/database/models/tenant.model';
import type { CountryStatusValue } from '../countries.constants';

/** 03-API-CONTRACT.md §1 — `{ "data": … }`. Declared locally per the precedent `me`'s own copy
 * documents: this envelope is an API-wide convention no task owns a shared home for. */
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

export interface CountryDto {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly timezone: string;
  readonly currencyCode: string;
  readonly dialingCode: string;
  readonly isHq: boolean;
  readonly status: CountryStatusValue;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toCountryDto(country: Country): CountryDto {
  return {
    id: country.id,
    code: country.code,
    name: country.name,
    timezone: country.timezone,
    currencyCode: country.currencyCode,
    dialingCode: country.dialingCode,
    isHq: country.isHq,
    status: country.status as CountryStatusValue,
    createdAt: country.createdAt.toISOString(),
    updatedAt: country.updatedAt.toISOString(),
  };
}

/**
 * The one-time credential response — `POST /countries/:id/admins`, and the `admin` field of
 * `POST /countries` when `admin` was supplied (BACKLOG.md B-01).
 *
 * `temporaryPassword` is the plaintext, deliberately: it is generated once, returned once, and
 * never stored anywhere this DTO could later read it back from.
 */
export interface CountryAdminCreatedDto {
  readonly id: number;
  readonly email: string;
  readonly displayName: string;
  readonly role: 'country_admin';
  readonly countryId: number;
  readonly temporaryPassword: string;
}

export interface CreateCountryResultDto {
  readonly country: CountryDto;
  readonly admin: CountryAdminCreatedDto | null;
}

export interface CountryTenantSummaryDto {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly status: string;
}

export function toCountryTenantSummaryDto(tenant: Tenant): CountryTenantSummaryDto {
  return { id: tenant.id, code: tenant.code, name: tenant.name, status: tenant.status };
}

export interface CountrySummaryDto {
  readonly countryId: number;
  readonly tenantCount: number;
  readonly activeTenantCount: number;
  readonly campaignCount: number;
  readonly tenants: readonly CountryTenantSummaryDto[];
}
