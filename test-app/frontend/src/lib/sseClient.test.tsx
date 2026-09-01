/**
 * T-006 — `useSse`'s own contract: opens one `EventSource` per customer at the right URL,
 * re-subscribes (closing the old connection) when the customer changes (TC-2), invalidates the
 * caches a live event affects and republishes it on `sseBus` for T-010's toast, and rebuilds the
 * connection if the browser's own auto-retry ever gives up entirely (TC-8).
 *
 * jsdom has no real `EventSource` implementation, so every test substitutes a small, fully
 * controllable mock rather than depending on network/timer behaviour this module doesn't own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { queryKeys } from './queryKeys';
import { sseBus, useSse } from './sseClient';

type Listener = (event: MessageEvent<string>) => void;

class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: MockEventSource[] = [];

  readonly url: string;
  readyState = MockEventSource.OPEN;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: Listener) {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: Listener) {
    this.listeners.get(type)?.delete(handler);
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }

  /** Test helper: simulate the server pushing a named SSE event. */
  emit(type: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    this.listeners.get(type)?.forEach((handler) => handler(event));
  }

  /** Test helper: simulate the browser giving up entirely (readyState -> CLOSED, then `onerror`). */
  failFatally() {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.(new Event('error'));
  }
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useSse', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('opens no connection while customerId is null', () => {
    const queryClient = new QueryClient();
    renderHook(() => useSse(null), { wrapper: wrapperFor(queryClient) });

    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('opens one connection at the customer-scoped events URL', () => {
    const queryClient = new QueryClient();
    renderHook(() => useSse('priya-shah'), { wrapper: wrapperFor(queryClient) });

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/api/events?customerId=priya-shah');
  });

  it('re-subscribes on customer switch: closes the old connection, opens a new one', () => {
    const queryClient = new QueryClient();
    const { rerender } = renderHook(({ customerId }) => useSse(customerId), {
      wrapper: wrapperFor(queryClient),
      initialProps: { customerId: 'priya-shah' as string | null },
    });

    const first = MockEventSource.instances[0];
    expect(first.readyState).toBe(MockEventSource.OPEN);

    rerender({ customerId: 'marcus-tan' });

    expect(first.readyState).toBe(MockEventSource.CLOSED);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1].url).toBe('/api/events?customerId=marcus-tan');
  });

  it("a reward-earned event invalidates that customer's dashboard/rewards and republishes on sseBus", async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const busHandler = vi.fn();
    sseBus.addEventListener('reward-earned', busHandler);

    renderHook(() => useSse('priya-shah'), { wrapper: wrapperFor(queryClient) });
    const reward = {
      id: 'r1',
      customerId: 'priya-shah',
      campaignId: 1,
      campaignCode: 'SUMMER25',
      type: 'cashback',
      value: '5.00',
      currency: 'USD',
      status: 'unused',
      issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
    };

    MockEventSource.instances[0].emit('reward-earned', reward);

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.dashboard('priya-shah') }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.rewards('priya-shah') });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.activities('priya-shah') });
    expect(busHandler).toHaveBeenCalledTimes(1);
    expect((busHandler.mock.calls[0][0] as CustomEvent).detail).toEqual(reward);

    sseBus.removeEventListener('reward-earned', busHandler);
  });

  it('a progress-updated event invalidates campaign queries', async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useSse('priya-shah'), { wrapper: wrapperFor(queryClient) });
    MockEventSource.instances[0].emit('progress-updated', {
      campaignId: 1,
      trackerId: 2,
      componentId: 3,
      completedCount: 1,
      threshold: 2,
      trackerCompleted: false,
    });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.campaignsRoot }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.campaignRoot });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.activities('priya-shah') });
  });

  it('rebuilds the connection after the browser gives up entirely (TC-8)', () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    renderHook(() => useSse('priya-shah'), { wrapper: wrapperFor(queryClient) });

    expect(MockEventSource.instances).toHaveLength(1);
    MockEventSource.instances[0].failFatally();

    // Not yet — the reconnect is deliberately delayed, not instant.
    expect(MockEventSource.instances).toHaveLength(1);

    vi.advanceTimersByTime(2000);

    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1].url).toBe('/api/events?customerId=priya-shah');
  });

  it('does not reconnect after unmount', () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const { unmount } = renderHook(() => useSse('priya-shah'), {
      wrapper: wrapperFor(queryClient),
    });

    MockEventSource.instances[0].failFatally();
    unmount();
    vi.advanceTimersByTime(5000);

    expect(MockEventSource.instances).toHaveLength(1);
  });
});
