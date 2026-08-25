/**
 * T-034 — the `useQuery`/`useMutation` wrappers in `api.ts`. `api.test.ts` covers the plain
 * `fetch*`/`create*`/`update*` functions directly; this file covers the thin hook layer around
 * them — query keys wired correctly, and a mutation's `onSuccess` invalidation/cache-update
 * behaviour. Same shape `features/countries/api.hooks.test.tsx` (T-030) establishes.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Tenant } from '@reward-portal/shared';

const { mockGet, mockPost, mockPatch, mockPut } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPatch: vi.fn(),
  mockPut: vi.fn(),
}));

vi.mock('../../lib/apiClient', () => ({
  api: { get: mockGet, post: mockPost, patch: mockPatch, put: mockPut },
}));

import {
  budgetCeilingsQueryKey,
  tenantQueryKey,
  useActivateTenantMutation,
  useBudgetCeilingsQuery,
  useCreateTenantAdminMutation,
  useCreateTenantMutation,
  useTenantQuery,
  useTenantsQuery,
  useTenantsWithoutCeilingQuery,
  useUpdateTenantMutation,
  useUpsertBudgetCeilingMutation,
} from './api';

const tenant: Tenant = {
  id: 10,
  code: 'T001',
  name: 'Acme Retail',
  countryId: 1,
  schemaPrefix: null,
  contactEmail: null,
  contactPhone: null,
  status: 'pending_provisioning',
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
  mockPut.mockReset();
});

describe('useTenantsQuery', () => {
  it('fetches the list and resolves with the parsed data', async () => {
    mockGet.mockResolvedValue({
      data: { data: [tenant], meta: { page: 1, pageSize: 20, total: 1 } },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useTenantsQuery({ page: 1 }), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.data).toEqual([tenant]);
  });
});

describe('useTenantQuery', () => {
  it('fetches a single tenant', async () => {
    mockGet.mockResolvedValue({ data: { data: tenant } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useTenantQuery(10), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(tenant);
  });
});

describe('useCreateTenantMutation', () => {
  it('invalidates the tenants list on success', async () => {
    mockPost.mockResolvedValue({ data: { data: { tenant, admin: null } } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useCreateTenantMutation(), { wrapper: wrapper(client) });
    result.current.mutate({ code: 'T001', name: 'Acme Retail' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tenants'] });
  });
});

describe('useCreateTenantAdminMutation', () => {
  it('invalidates that tenant on success', async () => {
    mockPost.mockResolvedValue({
      data: {
        data: {
          id: 5,
          email: 'admin@example.invalid',
          displayName: 'Admin',
          role: 'tenant_admin',
          tenantId: 10,
          temporaryPassword: 'x',
        },
      },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useCreateTenantAdminMutation(10), {
      wrapper: wrapper(client),
    });
    result.current.mutate({ email: 'admin@example.invalid', displayName: 'Admin' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: tenantQueryKey(10) });
  });
});

describe('useActivateTenantMutation', () => {
  it('updates the cache and invalidates the list on success (TC-15)', async () => {
    const activated = { ...tenant, status: 'active' as const };
    mockPost.mockResolvedValue({ data: { data: activated } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const setQueryData = vi.spyOn(client, 'setQueryData');

    const { result } = renderHook(() => useActivateTenantMutation(10), {
      wrapper: wrapper(client),
    });
    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(setQueryData).toHaveBeenCalledWith(tenantQueryKey(10), activated);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tenants'] });
  });
});

describe('useUpdateTenantMutation', () => {
  it('updates the cache and invalidates the list on success (TC-18 suspension)', async () => {
    const updated = { ...tenant, status: 'suspended' as const };
    mockPatch.mockResolvedValue({ data: { data: updated } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const setQueryData = vi.spyOn(client, 'setQueryData');

    const { result } = renderHook(() => useUpdateTenantMutation(10), { wrapper: wrapper(client) });
    result.current.mutate({ status: 'suspended' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(setQueryData).toHaveBeenCalledWith(tenantQueryKey(10), updated);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tenants'] });
  });
});

describe('useBudgetCeilingsQuery / useUpsertBudgetCeilingMutation', () => {
  const ceiling = {
    id: 1,
    tenantId: 10,
    unitType: 'currency' as const,
    unitCode: 'MYR',
    maxCampaignBudget: '5000000.0000',
    warnAboveAmount: '4000000.0000',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('fetches the ceilings for a tenant', async () => {
    mockGet.mockResolvedValue({ data: { data: [ceiling] } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useBudgetCeilingsQuery(10), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([ceiling]);
  });

  it('updates the ceilings cache directly on success, keyed per tenant (TC-21/TC-22)', async () => {
    mockPut.mockResolvedValue({ data: { data: [ceiling] } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const setQueryData = vi.spyOn(client, 'setQueryData');

    const { result } = renderHook(() => useUpsertBudgetCeilingMutation(10), {
      wrapper: wrapper(client),
    });
    result.current.mutate({ unitType: 'currency', unitCode: 'MYR', maxCampaignBudget: '5000000' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(setQueryData).toHaveBeenCalledWith(budgetCeilingsQueryKey(10), [ceiling]);
  });
});

describe('useTenantsWithoutCeilingQuery (implementation note 7, TC-28)', () => {
  it('fetches the dashboard widget list', async () => {
    mockGet.mockResolvedValue({
      data: { data: [{ id: 10, code: 'T001', name: 'Acme Retail', countryId: 1 }] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useTenantsWithoutCeilingQuery(), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      { id: 10, code: 'T001', name: 'Acme Retail', countryId: 1 },
    ]);
  });
});
