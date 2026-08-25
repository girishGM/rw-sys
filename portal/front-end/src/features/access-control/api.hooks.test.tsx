/**
 * T-033 — exercises the thin `useQuery`/`useMutation` wrapper hooks in `api.ts` directly (rather
 * than through a mocked `./api`, as the component specs do), so the wrapper functions themselves
 * — not just the plain async functions `api.test.ts` covers — are real, exercised code.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const { mockGet, mockPost, mockPut, mockPatch } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPut: vi.fn(),
  mockPatch: vi.fn(),
}));

vi.mock('../../lib/apiClient', () => ({
  api: { get: mockGet, post: mockPost, put: mockPut, patch: mockPatch },
}));

import {
  useEntitiesQuery,
  useNavQuery,
  usePermissionsQuery,
  usePreviewMutation,
  usePutNavMutation,
  usePutPermissionsMutation,
  usePutWidgetsMutation,
  useReorderNavMutation,
  useReorderWidgetsMutation,
  useRolesQuery,
  useWidgetsQuery,
} from './api';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPut.mockReset();
  mockPatch.mockReset();
});

describe('read hooks', () => {
  it('useRolesQuery resolves through the real hook', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ role: 'maker', userCount: 1 }] } });
    const { result } = renderHook(() => useRolesQuery(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ role: 'maker', userCount: 1 }]);
  });

  it('useEntitiesQuery resolves through the real hook', async () => {
    mockGet.mockResolvedValue({
      data: { data: [{ entity: 'rule', actions: ['view'], protectedActions: [] }] },
    });
    const { result } = renderHook(() => useEntitiesQuery(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });

  it('useNavQuery resolves through the real hook', async () => {
    mockGet.mockResolvedValue({ data: { data: { role: 'maker', version: 1, items: [] } } });
    const { result } = renderHook(() => useNavQuery('maker'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockGet).toHaveBeenCalledWith('/admin/access-control/nav/maker');
  });

  it('useWidgetsQuery resolves through the real hook', async () => {
    mockGet.mockResolvedValue({ data: { data: { role: 'maker', version: 1, items: [] } } });
    const { result } = renderHook(() => useWidgetsQuery('maker'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockGet).toHaveBeenCalledWith('/admin/access-control/widgets/maker');
  });

  it('usePermissionsQuery resolves through the real hook', async () => {
    mockGet.mockResolvedValue({ data: { data: { role: 'maker', version: 1, permissions: {} } } });
    const { result } = renderHook(() => usePermissionsQuery('maker'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockGet).toHaveBeenCalledWith('/admin/access-control/permissions/maker');
  });
});

describe('mutation hooks', () => {
  it('usePutNavMutation posts through the real hook and updates the cache', async () => {
    const response = { role: 'maker', version: 2, items: [] };
    mockPut.mockResolvedValue({ data: { data: response } });
    const { result } = renderHook(() => usePutNavMutation('maker'), { wrapper });

    result.current.mutate({ expectedVersion: 1, items: [] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(response);
  });

  it('useReorderNavMutation patches through the real hook', async () => {
    const response = { role: 'maker', version: 2, items: [] };
    mockPatch.mockResolvedValue({ data: { data: response } });
    const { result } = renderHook(() => useReorderNavMutation('maker'), { wrapper });

    result.current.mutate({ expectedVersion: 1, order: [] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('usePutWidgetsMutation posts through the real hook', async () => {
    const response = { role: 'maker', version: 2, items: [] };
    mockPut.mockResolvedValue({ data: { data: response } });
    const { result } = renderHook(() => usePutWidgetsMutation('maker'), { wrapper });

    result.current.mutate({ expectedVersion: 1, items: [] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('useReorderWidgetsMutation patches through the real hook', async () => {
    const response = { role: 'maker', version: 2, items: [] };
    mockPatch.mockResolvedValue({ data: { data: response } });
    const { result } = renderHook(() => useReorderWidgetsMutation('maker'), { wrapper });

    result.current.mutate({ expectedVersion: 1, order: [] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('usePutPermissionsMutation posts through the real hook', async () => {
    const response = { role: 'maker', version: 2, permissions: {} };
    mockPut.mockResolvedValue({ data: { data: response } });
    const { result } = renderHook(() => usePutPermissionsMutation('maker'), { wrapper });

    result.current.mutate({ expectedVersion: 1, permissions: {} });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('usePreviewMutation posts through the real hook', async () => {
    const response = { role: 'merchant', nav: [], permissions: {}, widgets: [] };
    mockPost.mockResolvedValue({ data: { data: response } });
    const { result } = renderHook(() => usePreviewMutation(), { wrapper });

    result.current.mutate({ role: 'merchant' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(response);
  });
});
