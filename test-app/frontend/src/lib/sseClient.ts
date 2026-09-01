/**
 * T-006 — subscribes to `GET /api/events?customerId=` for the current customer (ARCHITECTURE.md
 * §3/§4), re-subscribing whenever `customerId` changes, and invalidates the React Query caches a
 * live event affects — the mechanism T-007's dashboard live-update and T-010's toast both depend
 * on. Mounted once, at the app shell (`components/Nav.tsx`'s nearest ancestor — see
 * `app/router.tsx`'s root layout), not per-page — a page only needs to read the query caches this
 * hook already keeps fresh, or subscribe to {@link sseBus} for the raw event itself.
 */
import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiBaseUrl } from './apiClient';
import { queryKeys } from './queryKeys';
import type { ProgressUpdatedPayload, RewardEarnedPayload } from '../types';

/** A tiny app-wide pub/sub so a page that doesn't own the one SSE connection (T-010's Activity
 * Simulator toast) can still react to the same live events this hook receives, without opening a
 * second `EventSource` for the same customer. */
export const sseBus = new EventTarget();

export interface ProgressUpdatedEvent extends Event {
  readonly detail: ProgressUpdatedPayload;
}

export interface RewardEarnedEvent extends Event {
  readonly detail: RewardEarnedPayload;
}

function buildEventsUrl(customerId: string): string {
  return `${apiBaseUrl()}/api/events?customerId=${encodeURIComponent(customerId)}`;
}

/** How long to wait before rebuilding a connection the browser itself gave up on (see the
 * `onerror` comment below) — short enough that a `tracking-service` restart mid-session (TC-8)
 * recovers well within a demo's patience, long enough not to hammer a service that's still down. */
const RECONNECT_DELAY_MS = 2000;

function invalidateForCustomer(queryClient: QueryClient, customerId: string): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(customerId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.campaignsRoot });
  void queryClient.invalidateQueries({ queryKey: queryKeys.campaignRoot });
  void queryClient.invalidateQueries({ queryKey: queryKeys.rewards(customerId) });
  // T-010 — a live event means `POST /api/activities` wrote a new `ActivityHistoryEntry`
  // (T-013) for this exact customer, so the Activity Simulator's feed reconciles from the same
  // one SSE mechanism every other cache here already uses — no second, parallel update path.
  void queryClient.invalidateQueries({ queryKey: queryKeys.activities(customerId) });
}

/**
 * Opens (and keeps open) one SSE connection for `customerId`. Pass `null` while the customer
 * roster is still loading (`useCustomer`'s own initial state) — no connection is opened until a
 * real id is available.
 */
export function useSse(customerId: string | null): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!customerId) return undefined;

    let active = true;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const handleProgressUpdated = (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as ProgressUpdatedPayload;
      invalidateForCustomer(queryClient, customerId);
      sseBus.dispatchEvent(new CustomEvent('progress-updated', { detail: payload }));
    };

    const handleRewardEarned = (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as RewardEarnedPayload;
      invalidateForCustomer(queryClient, customerId);
      sseBus.dispatchEvent(new CustomEvent('reward-earned', { detail: payload }));
    };

    const connect = () => {
      if (!active) return;
      const next = new EventSource(buildEventsUrl(customerId));
      next.addEventListener('progress-updated', handleProgressUpdated);
      next.addEventListener('reward-earned', handleRewardEarned);
      next.onerror = () => {
        // A dropped connection (e.g. `tracking-service` restarting mid-session, TC-8) leaves the
        // browser's own `EventSource` retrying automatically while `readyState` is `CONNECTING` —
        // no action needed there. Only if the browser gives up entirely and moves to `CLOSED` (a
        // repeated non-2xx from a still-down service) do we rebuild a fresh instance ourselves,
        // so the UI never goes silently stale forever.
        if (next.readyState === EventSource.CLOSED) {
          next.close();
          if (active) reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };
      source = next;
    };

    connect();

    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.removeEventListener('progress-updated', handleProgressUpdated);
      source?.removeEventListener('reward-earned', handleRewardEarned);
      source?.close();
    };
  }, [customerId, queryClient]);
}
