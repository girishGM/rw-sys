/**
 * T-036 — the `useQuery`/`useMutation` wrappers in `api.ts`. `api.test.ts` covers the plain
 * `fetch*`/`create*`/`update*` functions directly; this file covers the thin hook layer around
 * them — query keys wired correctly, and a mutation's `onSuccess` invalidation/cache-update
 * behaviour. Same shape `features/tenants/api.hooks.test.tsx` (T-034) establishes.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Merchant } from '@reward-portal/shared';

const { mockGet, mockPost, mockPatch } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPatch: vi.fn(),
}));

vi.mock('../../lib/apiClient', () => ({
  api: { get: mockGet, post: mockPost, patch: mockPatch },
}));

import {
  activitiesQueryKey,
  merchantQueryKey,
  storesQueryKey,
  useActiveCampaignsQuery,
  useActivitiesQuery,
  useCreateActivityMutation,
  useCreateMerchantMutation,
  useCreateStoreMutation,
  useMerchantQuery,
  useMerchantsQuery,
  useStoresQuery,
  useUpdateMerchantMutation,
} from './api';

const merchant: Merchant = {
  id: 100,
  tenantId: 10,
  merchantCode: 'M001',
  name: 'Acme Store',
  description: null,
  contactEmail: null,
  contactPhone: null,
  website: null,
  countryCode: 'MY',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPatch.mockReset();
});

describe('useMerchantsQuery', () => {
  it('fetches the list and resolves with the parsed data', async () => {
    mockGet.mockResolvedValue({
      data: { data: [merchant], meta: { page: 1, pageSize: 20, total: 1 } },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useMerchantsQuery({ page: 1 }), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.data).toEqual([merchant]);
  });
});

describe('useMerchantQuery', () => {
  it('fetches a single merchant', async () => {
    mockGet.mockResolvedValue({ data: { data: merchant } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useMerchantQuery(100), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(merchant);
  });
});

describe('useCreateMerchantMutation', () => {
  it('invalidates the merchants list on success', async () => {
    mockPost.mockResolvedValue({ data: { data: merchant } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useCreateMerchantMutation(), { wrapper: wrapper(client) });
    result.current.mutate({ merchantCode: 'M001', name: 'Acme Store', countryCode: 'MY' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['merchants'] });
  });
});

describe('useUpdateMerchantMutation', () => {
  it('updates the cache and invalidates the list on success (TC-20)', async () => {
    const updated = { ...merchant, status: 'inactive' as const };
    mockPatch.mockResolvedValue({ data: { data: updated } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const setQueryData = vi.spyOn(client, 'setQueryData');

    const { result } = renderHook(() => useUpdateMerchantMutation(100), {
      wrapper: wrapper(client),
    });
    result.current.mutate({ status: 'inactive' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(setQueryData).toHaveBeenCalledWith(merchantQueryKey(100), updated);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['merchants'] });
  });
});

describe('useActiveCampaignsQuery (TC-20)', () => {
  it('fetches the active campaigns for a merchant', async () => {
    mockGet.mockResolvedValue({
      data: { data: [{ id: 900, campaignCode: 'C900', name: 'Campaign 900', status: 'active' }] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useActiveCampaignsQuery(100), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      { id: 900, campaignCode: 'C900', name: 'Campaign 900', status: 'active' },
    ]);
  });
});

describe('useStoresQuery / useCreateStoreMutation', () => {
  const store = {
    id: 200,
    tenantId: 10,
    merchantId: 100,
    storeCode: 'S001',
    name: 'Main Store',
    address: null,
    city: null,
    state: null,
    postalCode: null,
    region: null,
    latitude: null,
    longitude: null,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('fetches the stores for a merchant', async () => {
    mockGet.mockResolvedValue({ data: { data: [store] } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useStoresQuery(100), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([store]);
  });

  it('invalidates the stores query for that merchant on success (TC-12)', async () => {
    mockPost.mockResolvedValue({ data: { data: store } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useCreateStoreMutation(100), { wrapper: wrapper(client) });
    result.current.mutate({ storeCode: 'S001', name: 'Main Store' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: storesQueryKey(100) });
  });
});

describe('useActivitiesQuery / useCreateActivityMutation', () => {
  const link = {
    id: 300,
    tenantId: 10,
    merchantId: 100,
    activityId: 50,
    storeId: null,
    commissionRate: null,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('fetches the activity links for a merchant', async () => {
    mockGet.mockResolvedValue({ data: { data: [link] } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useActivitiesQuery(100), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([link]);
  });

  it('invalidates the activities query for that merchant on success (TC-14)', async () => {
    mockPost.mockResolvedValue({ data: { data: link } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useCreateActivityMutation(100), {
      wrapper: wrapper(client),
    });
    result.current.mutate({ activityId: 50 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: activitiesQueryKey(100) });
  });
});
