/**
 * T-040 — the response bodies `/notifications` returns.
 *
 * `DataEnvelope`/`DataListEnvelope` are declared locally rather than imported from a shared
 * home, per the precedent `me/dto/bootstrap-response.dto.ts` and `countries/dto/
 * country-response.dto.ts` both document: `{ "data": … }` is an API-wide convention
 * (03-API-CONTRACT.md §1) that no task owns a shared file for.
 *
 * `NotificationDto`'s field names (`id`, `message`, `isRead`, `createdAt`) are load-bearing: they
 * are exactly the shape `front-end/src/layouts/notificationsApi.ts` (T-023) already parses and
 * `NotificationBell.spec.tsx` already asserts against — this task makes that already-shipped
 * contract real, it does not renegotiate it.
 */
import type { PortalUserNotification } from '@/database/portal-models/portal-user-notification.model';

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

export interface NotificationDto {
  readonly id: number;
  readonly notificationType: string;
  readonly title: string;
  readonly message: string;
  readonly entityType: string | null;
  readonly entityId: number | null;
  readonly entityLabel: string | null;
  readonly isRead: boolean;
  readonly readAt: string | null;
  readonly createdAt: string;
}

export function toNotificationDto(row: PortalUserNotification): NotificationDto {
  return {
    id: row.id,
    notificationType: row.notificationType,
    title: row.title,
    message: row.message,
    entityType: row.entityType,
    entityId: row.entityId,
    entityLabel: row.entityLabel,
    isRead: row.isRead,
    readAt: row.readAt === null ? null : row.readAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export interface UnreadCountDto {
  readonly count: number;
}

export interface MarkAllReadResultDto {
  readonly affected: number;
}
