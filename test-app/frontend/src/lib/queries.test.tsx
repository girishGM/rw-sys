/**
 * T-006 — `queries.ts`'s own contract: each hook surfaces real loading → success/error state from
 * `apiClient` via React Query (this task's Scope: "so pages get caching/loading/error states for
 * free"), and `usePostActivity` invalidates the caches a completed activity can affect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import * as apiClient from './apiClient';
import { useActivities, useCustomers, useDashboard, usePostActivity } from './queries';
import { queryKeys } from './queryKeys';

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('queries', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('useCustomers() reflects loading then the resolved roster', async () => {
    vi.spyOn(apiClient, 'getCustomers').mockResolvedValue([
      { id: 'priya-shah', displayName: 'Priya Shah', avatarInitials: 'PS' },
    ]);
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useCustomers(), { wrapper: wrapperFor(queryClient) });

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      { id: 'priya-shah', displayName: 'Priya Shah', avatarInitials: 'PS' },
    ]);
  });

  it('useDashboard(null) stays disabled — no fetch fires until a customerId is set', () => {
    const spy = vi.spyOn(apiClient, 'getDashboard').mockResolvedValue({} as never);
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useDashboard(null), { wrapper: wrapperFor(queryClient) });

    expect(result.current.fetchStatus).toBe('idle');
    expect(spy).not.toHaveBeenCalled();
  });

  it('useDashboard() surfaces a rejected fetch as query error state, not a thrown exception', async () => {
    vi.spyOn(apiClient, 'getDashboard').mockRejectedValue(new apiClient.ApiError('boom', 502));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useDashboard('priya-shah'), {
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ message: 'boom', status: 502 });
  });

  it("usePostActivity() invalidates that customer's dashboard/campaigns/rewards/activities on success", async () => {
    vi.spyOn(apiClient, 'postActivity').mockResolvedValue({
      activityId: 'a1',
      customerId: 'priya-shah',
      activityType: 'purchase',
      merchant: null,
      amount: null,
      matched: true,
      progress: [],
      rewards: [],
    });
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => usePostActivity(), { wrapper: wrapperFor(queryClient) });

    await act(async () => {
      await result.current.mutateAsync({ customerId: 'priya-shah', activityType: 'purchase' });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.dashboard('priya-shah') });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.rewards('priya-shah') });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.campaignsRoot });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.campaignRoot });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.activities('priya-shah') });
  });

  it('useActivities(null) stays disabled — no fetch fires until a customerId is set', () => {
    const spy = vi.spyOn(apiClient, 'getActivities').mockResolvedValue([]);
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useActivities(null), { wrapper: wrapperFor(queryClient) });

    expect(result.current.fetchStatus).toBe('idle');
    expect(spy).not.toHaveBeenCalled();
  });

  it('useActivities() reflects loading then the resolved history', async () => {
    vi.spyOn(apiClient, 'getActivities').mockResolvedValue([
      {
        id: 'a1',
        customerId: 'priya-shah',
        timestamp: '2026-06-01T12:00:00.000Z',
        activityType: 'Grocery Purchase',
        merchant: null,
        amount: null,
        description: 'Grocery Purchase — progress updated',
        matched: true,
        progress: [],
        rewards: [],
      },
    ]);
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useActivities('priya-shah'), {
      wrapper: wrapperFor(queryClient),
    });

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });
});
