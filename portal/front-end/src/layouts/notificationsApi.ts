/**
 * T-023 — `NotificationBell`'s data layer. Calls the routes 03-API-CONTRACT.md §14 names —
 * `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/:id/read`,
 * `POST /notifications/read-all`, all backed by the already-modelled `user_notifications` table
 * (`back-end/src/database/models/user-notification.model.ts`, 00-ARCHITECTURE.md §3.1) — but,
 * same honest caveat as `features/dashboard/widgets/api.ts` and `useScopeLabels.ts`, no
 * `back-end/src/modules/notifications` exists yet (that build-out is T-040's, still `pending`).
 * Until it ships, every call below resolves to a normal `ApiError` the bell already renders
 * gracefully (a `0` badge, an empty-state drawer) — never a crash, exactly `toApiError`'s
 * contract. Flagged for the architect in the completion report alongside the other two.
 */
import { api } from '../lib/apiClient';
import { toApiError } from '../lib/apiError';

export const NOTIFICATIONS_UNREAD_COUNT_KEY = ['notifications', 'unread-count'] as const;
export const NOTIFICATIONS_LIST_KEY = ['notifications', 'list'] as const;

/** 04-FRONTEND.md implementation note 7: "polls unread count every 60 s (not more often)". */
export const UNREAD_POLL_INTERVAL_MS = 60_000;

export interface NotificationItem {
  readonly id: number;
  readonly message: string;
  readonly isRead: boolean;
  readonly createdAt: string;
}

interface UnreadCountResponse {
  readonly count?: unknown;
}

function toCount(value: UnreadCountResponse): number {
  return typeof value.count === 'number' && Number.isFinite(value.count) ? value.count : 0;
}

export async function fetchUnreadCount(): Promise<number> {
  try {
    const response = await api.get<{ data: UnreadCountResponse }>('/notifications/unread-count');
    return toCount(response.data.data);
  } catch (error) {
    throw toApiError(error);
  }
}

export async function fetchNotifications(): Promise<NotificationItem[]> {
  try {
    const response = await api.get<{ data: NotificationItem[] }>('/notifications');
    return Array.isArray(response.data.data) ? response.data.data : [];
  } catch (error) {
    throw toApiError(error);
  }
}

export async function markAllNotificationsRead(): Promise<void> {
  try {
    await api.post('/notifications/read-all');
  } catch (error) {
    throw toApiError(error);
  }
}
