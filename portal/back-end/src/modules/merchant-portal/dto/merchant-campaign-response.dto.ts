/**
 * T-039 — the response bodies `/merchant/*` returns, and the only shapes it may return.
 *
 * Built by hand from the model instances the service loads, never by spreading a Sequelize row —
 * the same construction rule `merchants/dto/merchant-response.dto.ts` (T-036) records, for the
 * same reason: no internal id or column beyond what the UI needs, ever, as a property of the code
 * rather than of somebody remembering to strip a column.
 *
 * ### This is an explicit, deliberately small projection — not `campaign.schema.ts` reused
 *
 * Implementation note 2: *"Build an explicit response DTO; do not reuse the maker's DTO."*
 * {@link MerchantCampaignDetailDto} therefore carries no `budgetAmount`/`budgetCurrency` (the
 * legacy budget pair `tenant-campaign.model.ts` documents), no `tenantId`, and nothing about any
 * other participant — only what 03-API-CONTRACT.md §13 and the task's own implementation note 2
 * grant a merchant: the campaign header, its own participation row, and its own
 * `merchant_activities` (never another merchant's, never filtered through a table
 * `scope-strategy.ts` denies this role — see `merchant-portal.service.ts`'s own header for why).
 */
import type { CampaignMerchant } from '@/database/models/campaign-merchant.model';
import type { MerchantActivity } from '@/database/models/merchant-activity.model';
import type { TenantCampaign } from '@/database/models/tenant-campaign.model';

/** 03-API-CONTRACT.md §1 — `{ "data": … }`. Declared locally per the precedent
 * `merchant-response.dto.ts` documents: this envelope is an API-wide convention no task owns a
 * shared home for. */
export interface DataEnvelope<T> {
  readonly data: T;
}

export function envelope<T>(data: T): DataEnvelope<T> {
  return { data };
}

/** One row of `GET /merchant/campaigns` — the campaign header only, nothing participation- or
 * activity-specific (TC-1…TC-7). */
export interface MerchantCampaignListItemDto {
  readonly id: number;
  readonly campaignCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly region: string | null;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: string;
}

export function toMerchantCampaignListItemDto(
  campaign: TenantCampaign,
): MerchantCampaignListItemDto {
  return {
    id: campaign.id,
    campaignCode: campaign.campaignCode,
    name: campaign.name,
    description: campaign.description,
    region: campaign.region,
    startDate: campaign.startDate.toISOString(),
    endDate: campaign.endDate.toISOString(),
    status: campaign.status,
  };
}

/** One `merchant_activities` row, projected for the merchant's own eyes only — this is exactly
 * "its own activities and commission terms" (implementation note 2), never another merchant's. */
export interface MerchantOwnActivityDto {
  readonly activityId: number;
  readonly activityName: string;
  readonly storeId: number | null;
  /** `decimal(5,2)` — never coerced to `number` (the model's own header). `null` when no rate
   * was set. */
  readonly commissionRate: string | null;
}

export function toMerchantOwnActivityDto(
  link: MerchantActivity,
  activityName: string,
): MerchantOwnActivityDto {
  return {
    activityId: link.activityId,
    activityName,
    storeId: link.storeId,
    commissionRate: link.commissionRate,
  };
}

/** `GET /merchant/campaigns/:id` — the campaign header plus this merchant's own participation and
 * its own activities. Implementation note 2: never another participant's commission rate, never
 * the campaign's internal budget. */
export interface MerchantCampaignDetailDto extends MerchantCampaignListItemDto {
  readonly maxParticipants: number | null;
  readonly participation: {
    readonly status: string;
    readonly joinedAt: string;
  };
  readonly myActivities: readonly MerchantOwnActivityDto[];
}

export function toMerchantCampaignDetailDto(
  campaign: TenantCampaign,
  participation: CampaignMerchant,
  myActivities: readonly MerchantOwnActivityDto[],
): MerchantCampaignDetailDto {
  return {
    ...toMerchantCampaignListItemDto(campaign),
    maxParticipants: campaign.maxParticipants,
    participation: {
      status: participation.status,
      joinedAt: participation.createdAt.toISOString(),
    },
    myActivities,
  };
}

/**
 * `GET /merchant/summary` — the dashboard KPI/chart/list data the three `merchant`
 * `role_dashboard_widgets` rows need (01-DATABASE.md §5.3: `kpi_active_campaigns`,
 * `kpi_my_activities`, `chart_campaign_performance`, `list_my_campaigns`).
 *
 * Implementation note 5: *"Where a metric has no source table, render an honest 'not available'
 * state rather than a fabricated number."* `campaignPerformance` is exactly that — this system
 * has no redemption/transaction table keyed by campaign and merchant (`reward_delivery_queue` is
 * keyed by `reward_system_id` alone, with no campaign or merchant column at all), so there is
 * genuinely nothing to chart, and the response says so explicitly rather than shipping a `0` or a
 * made-up series (TC-19).
 */
export interface MerchantCampaignPerformanceUnavailable {
  readonly available: false;
  readonly reason: string;
}

export interface MerchantCampaignPerformanceAvailable {
  readonly available: true;
  readonly series: readonly { readonly label: string; readonly value: number }[];
}

export type MerchantCampaignPerformanceDto =
  MerchantCampaignPerformanceUnavailable | MerchantCampaignPerformanceAvailable;

export interface MerchantSummaryDto {
  readonly activeCampaignsCount: number;
  readonly myActivitiesCount: number;
  readonly campaignPerformance: MerchantCampaignPerformanceDto;
  readonly participatingCampaigns: readonly MerchantCampaignListItemDto[];
}
