/**
 * T-036 — the response bodies `/merchants` returns, and the only shapes it may return.
 *
 * Built by hand from the model instances the service loads, never by spreading a Sequelize row
 * — the same construction rule `tenants/dto/tenant-response.dto.ts` records, for the same
 * reason: no internal id beyond what the UI needs, ever, as a property of the code rather than
 * of somebody remembering to strip a column.
 */
import type { Merchant } from '@/database/models/merchant.model';
import type { MerchantActivity } from '@/database/models/merchant-activity.model';
import type { MerchantStore } from '@/database/models/merchant-store.model';
import type { TenantCampaign } from '@/database/models/tenant-campaign.model';
import type { MerchantStatusValue } from '../merchants.constants';

/** 03-API-CONTRACT.md §1 — `{ "data": … }`. Declared locally per the precedent
 * `tenant-response.dto.ts` documents: this envelope is an API-wide convention no task owns a
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

export interface MerchantDto {
  readonly id: number;
  readonly tenantId: number;
  readonly merchantCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly website: string | null;
  readonly countryCode: string;
  readonly status: MerchantStatusValue;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toMerchantDto(merchant: Merchant): MerchantDto {
  return {
    id: merchant.id,
    tenantId: merchant.tenantId,
    merchantCode: merchant.merchantCode,
    name: merchant.name,
    description: merchant.description,
    contactEmail: merchant.contactEmail,
    contactPhone: merchant.contactPhone,
    website: merchant.website,
    countryCode: merchant.countryCode,
    status: merchant.status as MerchantStatusValue,
    createdAt: merchant.createdAt.toISOString(),
    updatedAt: merchant.updatedAt.toISOString(),
  };
}

export interface MerchantStoreDto {
  readonly id: number;
  readonly tenantId: number;
  readonly merchantId: number;
  readonly storeCode: string;
  readonly name: string;
  readonly address: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly region: string | null;
  /** `decimal(10,7)` — never coerced to `number` (the model's own header). */
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toMerchantStoreDto(store: MerchantStore): MerchantStoreDto {
  return {
    id: store.id,
    tenantId: store.tenantId,
    merchantId: store.merchantId,
    storeCode: store.storeCode,
    name: store.name,
    address: store.address,
    city: store.city,
    state: store.state,
    postalCode: store.postalCode,
    region: store.region,
    latitude: store.latitude,
    longitude: store.longitude,
    status: store.status,
    createdAt: store.createdAt.toISOString(),
    updatedAt: store.updatedAt.toISOString(),
  };
}

export interface MerchantActivityDto {
  readonly id: number;
  readonly tenantId: number;
  readonly merchantId: number;
  readonly activityId: number;
  readonly storeId: number | null;
  /** `decimal(5,2)` — never coerced to `number`. `null` when no rate was set. */
  readonly commissionRate: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toMerchantActivityDto(link: MerchantActivity): MerchantActivityDto {
  return {
    id: link.id,
    tenantId: link.tenantId,
    merchantId: link.merchantId,
    activityId: link.activityId,
    storeId: link.storeId,
    commissionRate: link.commissionRate,
    status: link.status,
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString(),
  };
}

/** One row of `GET /merchants/:id/active-campaigns` — the deactivation-warning data source
 * (implementation note 7, TC-20). Deliberately a small subset of the full campaign shape
 * (`tenant_campaigns` is another task's model to expose in full — `back-end/src/modules/
 * merchants/**` is this task's only file scope, AGENT-PROTOCOL R9), matching what the
 * confirmation dialog shows. */
export interface ActiveCampaignDto {
  readonly id: number;
  readonly campaignCode: string;
  readonly name: string;
  readonly status: string;
}

export function toActiveCampaignDto(campaign: TenantCampaign): ActiveCampaignDto {
  return {
    id: campaign.id,
    campaignCode: campaign.campaignCode,
    name: campaign.name,
    status: campaign.status,
  };
}
