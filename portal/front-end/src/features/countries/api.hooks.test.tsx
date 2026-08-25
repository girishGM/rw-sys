/**
 * T-030 — the `useQuery`/`useMutation` wrappers in `api.ts`. `api.test.ts` covers the plain
 * `fetch*`/`create*`/`updateCountry` functions directly (the actual request shape, response
 * parsing, error mapping); this file covers the thin hook layer around them — query keys wired
 * correctly, and a mutation's `onSuccess` invalidation/cache-update behaviour — which a mocked
 * `./api` module (as `CountriesListPage.test.tsx` and the two modal suites use) never exercises.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Country } from '@reward-portal/shared';

const { mockGet, mockPost, mockPatch } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPatch: vi.fn(),
}));

vi.mock('../../lib/apiClient', () => ({
  api: { get: mockGet, post: mockPost, patch: mockPatch },
}));

import {
  countryQueryKey,
  countrySummaryQueryKey,
  useCountriesQuery,
  useCountryQuery,
  useCountrySummaryQuery,
  useCreateCountryAdminMutation,
  useCreateCountryMutation,
  useUpdateCountryMutation,
} from './api';

const country: Country = {
  id: 1,
  code: 'MY',
  name: 'Malaysia',
  timezone: 'Asia/Kuala_Lumpur',
  currencyCode: 'MYR',
  dialingCode: '+60',
  isHq: false,
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

describe('useCountriesQuery', () => {
  it('fetches the list and resolves with the parsed data', async () => {
    mockGet.mockResolvedValue({
      data: { data: [country], meta: { page: 1, pageSize: 20, total: 1 } },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useCountriesQuery({ page: 1 }), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.data).toEqual([country]);
  });
});

describe('useCountryQuery / useCountrySummaryQuery', () => {
  it('fetch a single country and its summary, keyed independently', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith('/summary')) {
        return Promise.resolve({
          data: {
            data: {
              countryId: 1,
              tenantCount: 0,
              activeTenantCount: 0,
              campaignCount: 0,
              tenants: [],
            },
          },
        });
      }
      return Promise.resolve({ data: { data: country } });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result: countryResult } = renderHook(() => useCountryQuery(1), {
      wrapper: wrapper(client),
    });
    const { result: summaryResult } = renderHook(() => useCountrySummaryQuery(1), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(countryResult.current.isSuccess).toBe(true));
    await waitFor(() => expect(summaryResult.current.isSuccess).toBe(true));

    expect(countryResult.current.data).toEqual(country);
    expect(summaryResult.current.data?.countryId).toBe(1);
    expect(countryQueryKey(1)).not.toEqual(countrySummaryQueryKey(1));
  });
});

describe('useCreateCountryMutation', () => {
  it('invalidates the countries list on success', async () => {
    mockPost.mockResolvedValue({ data: { data: { country, admin: null } } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useCreateCountryMutation(), { wrapper: wrapper(client) });

    result.current.mutate({
      code: 'MY',
      name: 'Malaysia',
      timezone: 'Asia/Kuala_Lumpur',
      currencyCode: 'MYR',
      dialingCode: '+60',
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['countries'] });
  });
});

describe('useCreateCountryAdminMutation', () => {
  it('invalidates that country on success', async () => {
    mockPost.mockResolvedValue({
      data: {
        data: {
          id: 5,
          email: 'admin@example.invalid',
          displayName: 'Admin',
          role: 'country_admin',
          countryId: 1,
          temporaryPassword: 'x',
        },
      },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useCreateCountryAdminMutation(1), {
      wrapper: wrapper(client),
    });
    result.current.mutate({ email: 'admin@example.invalid', displayName: 'Admin' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: countryQueryKey(1) });
  });
});

describe('useUpdateCountryMutation', () => {
  it('updates the cache and invalidates the list and the summary on success', async () => {
    const updated = { ...country, status: 'inactive' as const };
    mockPatch.mockResolvedValue({ data: { data: updated } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const setQueryData = vi.spyOn(client, 'setQueryData');

    const { result } = renderHook(() => useUpdateCountryMutation(1), { wrapper: wrapper(client) });
    result.current.mutate({ status: 'inactive', confirm: true });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(setQueryData).toHaveBeenCalledWith(countryQueryKey(1), updated);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['countries'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: countrySummaryQueryKey(1) });
  });
});
