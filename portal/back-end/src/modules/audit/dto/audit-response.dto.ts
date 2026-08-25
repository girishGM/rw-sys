/**
 * T-040 — the response bodies `/audit/campaigns` and `/audit/portal` return.
 *
 * `DataEnvelope`/`DataListEnvelope` are declared locally, same precedent as
 * `notifications/dto/notification-response.dto.ts` and `me`/`countries` before it.
 */
import type { CampaignAuditTrail } from '@/database/models/campaign-audit-trail.model';
import type { PortalAuditLog } from '@/database/portal-models/portal-audit-log.model';

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

export interface CampaignAuditRowDto {
  readonly id: number;
  readonly tenantId: number;
  readonly campaignId: number;
  readonly entityType: string;
  readonly entityId: number | null;
  readonly action: string;
  readonly fieldChanges: Record<string, unknown>;
  readonly performedBy: number;
  readonly performedAt: string;
  readonly approvedBy: number | null;
  readonly approvedAt: string | null;
  readonly comment: string | null;
}

export function toCampaignAuditRowDto(row: CampaignAuditTrail): CampaignAuditRowDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    campaignId: row.campaignId,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    fieldChanges: row.fieldChanges,
    performedBy: row.performedBy,
    performedAt: row.performedAt.toISOString(),
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt === null ? null : row.approvedAt.toISOString(),
    comment: row.comment,
  };
}

export interface PortalAuditRowDto {
  readonly id: string;
  readonly eventType: string;
  readonly actorId: number | null;
  readonly actorRole: string | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly countryId: number | null;
  readonly tenantId: number | null;
  readonly ipAddress: string | null;
  readonly detail: Record<string, unknown> | null;
  readonly occurredAt: string;
}

export function toPortalAuditRowDto(row: PortalAuditLog): PortalAuditRowDto {
  return {
    id: row.id,
    eventType: row.eventType,
    actorId: row.actorId,
    actorRole: row.actorRole,
    targetType: row.targetType,
    targetId: row.targetId,
    countryId: row.countryId,
    tenantId: row.tenantId,
    ipAddress: row.ipAddress,
    detail: row.detail,
    occurredAt: row.occurredAt.toISOString(),
  };
}
