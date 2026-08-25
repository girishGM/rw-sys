/**
 * T-035 — the `useQuery`/`useMutation` wrappers in `api.ts`. `api.test.ts` covers the plain
 * `fetch*`/`create*`/`update*`/`deactivate*`/`reset*` functions directly; this file covers the
 * thin hook layer around them — query keys wired correctly, and a mutation's `onSuccess`
 * invalidation/cache-update behaviour. Same shape `features/tenants/api.hooks.test.tsx` (T-034)
 * establishes.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { User } from '@reward-portal/shared';

const { mockGet, mockPost, mockPatch } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPatch: vi.fn(),
}));

vi.mock('../../lib/apiClient', () => ({
  api: { get: mockGet, post: mockPost, patch: mockPatch },
}));

import {
  useCreateUserMutation,
  useDeactivateUserMutation,
  useResetUserPasswordMutation,
  useUpdateUserMutation,
  useUserQuery,
  useUsersQuery,
  userQueryKey,
} from './api';

const user: User = {
  id: 500,
  email: 'maker@example.invalid',
  displayName: 'A Maker',
  role: 'maker',
  countryId: 1,
  tenantId: 10,
  merchantId: null,
  status: 'active',
  mustChangePassword: true,
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

describe('useUsersQuery', () => {
  it('fetches the list and resolves with the parsed data', async () => {
    mockGet.mockResolvedValue({
      data: { data: [user], meta: { page: 1, pageSize: 20, total: 1 } },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useUsersQuery({ page: 1 }), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.data).toEqual([user]);
  });
});

describe('useUserQuery', () => {
  it('fetches a single user', async () => {
    mockGet.mockResolvedValue({ data: { data: user } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useUserQuery(500), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(user);
  });
});

describe('useCreateUserMutation', () => {
  it('invalidates the users list on success', async () => {
    mockPost.mockResolvedValue({ data: { data: { ...user, temporaryPassword: 'x' } } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useCreateUserMutation(), { wrapper: wrapper(client) });
    result.current.mutate({
      email: 'maker@example.invalid',
      displayName: 'A Maker',
      role: 'maker',
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['users'] });
  });
});

describe('useUpdateUserMutation', () => {
  it('updates the cache and invalidates the list on success', async () => {
    const updated = { ...user, displayName: 'Renamed' };
    mockPatch.mockResolvedValue({ data: { data: updated } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const setQueryData = vi.spyOn(client, 'setQueryData');

    const { result } = renderHook(() => useUpdateUserMutation(500), { wrapper: wrapper(client) });
    result.current.mutate({ displayName: 'Renamed' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(setQueryData).toHaveBeenCalledWith(userQueryKey(500), updated);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['users'] });
  });
});

describe('useDeactivateUserMutation', () => {
  it('updates the cache and invalidates the list on success (TC-21)', async () => {
    const deactivated = { ...user, status: 'inactive' as const };
    mockPost.mockResolvedValue({ data: { data: deactivated } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const setQueryData = vi.spyOn(client, 'setQueryData');

    const { result } = renderHook(() => useDeactivateUserMutation(500), {
      wrapper: wrapper(client),
    });
    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(setQueryData).toHaveBeenCalledWith(userQueryKey(500), deactivated);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['users'] });
  });
});

describe('useResetUserPasswordMutation', () => {
  it('invalidates that user on success (TC-24)', async () => {
    mockPost.mockResolvedValue({ data: { data: { ...user, temporaryPassword: 'x' } } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useResetUserPasswordMutation(500), {
      wrapper: wrapper(client),
    });
    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: userQueryKey(500) });
  });
});
