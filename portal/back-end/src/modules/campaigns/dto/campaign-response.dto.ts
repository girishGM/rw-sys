/**
 * T-037 — the response shapes of `/campaigns`, and the mappers that build them.
 *
 * Every type here is imported from `packages/shared` rather than redeclared: the SPA parses each
 * response through the very same Zod schema (`features/campaigns/api.ts`), so a mapper that
 * forgets a field or renames one fails the front end's own contract test rather than shipping a
 * silent `undefined` deep in a form. Declaring a parallel back-end-only interface would remove
 * exactly that property.
 *
 * ### Instants and dates are serialised differently, on purpose
 *
 * A genuine instant (`approvedAt`, `createdAt`, `performedAt`) becomes an ISO-8601 string via
 * `toISOString()` and is rendered in the reader's own timezone — that is what "when did this
 * happen" means.
 *
 * A campaign's `startDate`/`endDate` are **not** instants. They are calendar dates, and they are
 * serialised as `YYYY-MM-DD` through {@link calendarDateOf} (T-065). Serialising them as instants
 * is what made the same campaign end on the 15th in UTC and the 16th in `Asia/Kolkata`; see
 * `campaign-date.ts` for the full diagnosis.
 */
import type {
  Campaign,
  CampaignAuditEntry,
  CampaignCapRow,
  CampaignMerchantLink,
} from '@reward-portal/shared';
import type { CampaignCap, Merchant, TenantCampaign } from '@/database/models';
import type { PortalCampaignAuditTrail } from '@/database/portal-models';
import { calendarDateOf } from '../campaign-date';
import { effectiveStatus, isEditable } from '../campaign-state-machine';

/** 03-API-CONTRACT.md §1 — `{ data }` for a single resource, `{ data, meta }` for a list. */
export interface DataEnvelope<T> {
  readonly data: T;
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

export function envelope<T>(data: T): DataEnvelope<T> {
  return { data };
}

/**
 * One campaign header.
 *
 * `lastApprovalStatus` and `lastReviewComment` come from the campaign's most recent
 * `portal_approval_requests` row, which the service loads alongside; they are what turn a stored
 * `draft` into the presented `returned` (see `campaign-state-machine.ts`) and what drives the
 * maker's "sent back with a comment" banner.
 */
export function toCampaignDto(
  row: TenantCampaign,
  context: {
    readonly lastApprovalStatus: string | null;
    readonly lastReviewComment: string | null;
  },
): Campaign {
  return {
    id: row.id,
    tenantId: row.tenantId,
    campaignCode: row.campaignCode,
    name: row.name,
    description: row.description,
    startDate: calendarDateOf(row.startDate),
    endDate: calendarDateOf(row.endDate),
    status: row.status as Campaign['status'],
    effectiveStatus: effectiveStatus(row.status, context.lastApprovalStatus),
    maxParticipants: row.maxParticipants,
    // `decimal(18,2)`; Sequelize hands it back as a string and nothing here coerces it.
    budgetAmount: row.budgetAmount,
    budgetCurrency: row.budgetCurrency === null ? null : row.budgetCurrency.trim(),
    createdBy: row.createdBy,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt === null ? null : row.approvedAt.toISOString(),
    lastReviewComment: context.lastReviewComment,
    editable: isEditable(row.status),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** One `campaign_merchants` row joined to its merchant, for step 2's chip list. */
export function toCampaignMerchantDto(
  linkId: number,
  merchant: Merchant,
  status: string,
): CampaignMerchantLink {
  return {
    id: linkId,
    merchantId: merchant.id,
    merchantCode: merchant.merchantCode,
    name: merchant.name,
    status,
  };
}

/** One `campaign_caps` row. `window_*` are `time` columns — Postgres returns `HH:MM:SS`. */
export function toCampaignCapDto(row: CampaignCap): CampaignCapRow {
  return {
    id: row.id,
    capClass: row.capClass,
    scopeLevel: row.scopeLevel,
    scopeRefId: row.scopeRefId,
    periodType: row.periodType,
    periodValue: row.periodValue,
    windowStartTime: row.windowStartTime,
    windowEndTime: row.windowEndTime,
    periodTimezone: row.periodTimezone,
    unitType: row.unitType,
    unitCode: row.unitCode,
    rewardType: row.rewardType,
    maxTotalAmount: row.maxTotalAmount,
    maxOccurrences: row.maxOccurrences,
    maxCustomers: row.maxCustomers,
    onBreach: row.onBreach,
    warnAtPercent: row.warnAtPercent,
    status: row.status,
  };
}

/** One `portal_campaign_audit_trail` row — `GET /campaigns/:id/audit`. */
export function toCampaignAuditDto(
  row: PortalCampaignAuditTrail,
  performerName: string | null,
): CampaignAuditEntry {
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    fieldChanges: row.fieldChanges,
    performedBy: row.performedBy,
    performedByName: performerName,
    performedAt: row.performedAt.toISOString(),
    comment: row.comment,
  };
}
