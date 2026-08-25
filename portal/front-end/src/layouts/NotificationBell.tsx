/**
 * T-023 — the top bar's unread-notification indicator (04-FRONTEND.md §1, implementation
 * note 7). Polls the unread count every {@link UNREAD_POLL_INTERVAL_MS} and opens a `Drawer`
 * (T-021 — already focus-trapped, Escape-to-close) listing the feed on click.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { cx } from '../components/internal/cx';
import {
  NOTIFICATIONS_LIST_KEY,
  NOTIFICATIONS_UNREAD_COUNT_KEY,
  UNREAD_POLL_INTERVAL_MS,
  fetchNotifications,
  fetchUnreadCount,
  markAllNotificationsRead,
} from './notificationsApi';

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const unread = useQuery({
    queryKey: NOTIFICATIONS_UNREAD_COUNT_KEY,
    queryFn: fetchUnreadCount,
    refetchInterval: UNREAD_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  const list = useQuery({
    queryKey: NOTIFICATIONS_LIST_KEY,
    queryFn: fetchNotifications,
    enabled: open,
  });

  const markAll = useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_UNREAD_COUNT_KEY });
      void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_LIST_KEY });
    },
  });

  const count = unread.data ?? 0;
  const badgeText = count > 99 ? '99+' : String(count);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={count > 0 ? `Notifications, ${String(count)} unread` : 'Notifications'}
        className={cx(
          'relative rounded-control p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
        )}
      >
        <Bell className="size-5" aria-hidden="true" />
        {count > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger-600 px-1 text-[10px] font-semibold text-white"
          >
            {badgeText}
          </span>
        )}
      </button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Notifications"
        footer={
          <button
            type="button"
            onClick={() => markAll.mutate()}
            disabled={markAll.isPending || count === 0}
            className="inline-flex items-center gap-1.5 rounded-control px-3 py-1.5 text-sm font-medium text-primary-700 hover:bg-primary-50 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-transparent"
          >
            <CheckCheck className="size-4" aria-hidden="true" />
            Mark all as read
          </button>
        }
      >
        {list.isLoading ? (
          <div className="space-y-3" role="status" aria-label="Loading notifications">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : list.isError ? (
          <EmptyState message="Couldn't load notifications" description={list.error.message} />
        ) : list.data && list.data.length > 0 ? (
          <ul className="divide-y divide-slate-100">
            {list.data.map((item) => (
              <li key={item.id} className="flex items-start gap-2 py-3">
                {!item.isRead && (
                  <span
                    aria-label="Unread"
                    className="mt-1.5 size-2 shrink-0 rounded-full bg-primary-600"
                  />
                )}
                <div>
                  <p className="text-sm text-slate-800">{item.message}</p>
                  <p className="mt-0.5 text-xs text-slate-400">{item.createdAt}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState message="No notifications" description="You're all caught up." />
        )}
      </Drawer>
    </>
  );
}
