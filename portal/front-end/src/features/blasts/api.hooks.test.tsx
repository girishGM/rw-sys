/**
 * T-041 — the `useQuery`/`useMutation` wrappers in `api.ts`. `api.test.ts` covers the plain
 * `fetch*`/`previewBlast`/`createBlast` functions directly; this file covers the thin hook
 * layer around them — query keys wired correctly, and `useCreateBlastMutation`'s broad
 * `onSuccess` invalidation (blasts, versions and countries all change on a real blast) — which
 * a mocked `./api` module (as `BlastDialog.test.tsx`/`a11y.test.tsx` use) never exercises.
 * Follows the exact pattern `features/countries/api.hooks.test.tsx` (T-030) established.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Blast, BlastPreviewResponse } from '@reward-portal/shared';

const { mockGet, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock('../../lib/apiClient', () => ({ api: { get: mockGet, post: mockPost } }));

import {
  blastQueryKey,
  blastsQueryKey,
  useBlastQuery,
  useBlastsQuery,
  useCreateBlastMutation,
  usePreviewBlastMutation,
} from './api';

const blast: Blast = {
  id: 700,
  entityType: 'rule',
  entityId: 1,
  versionId: 10,
  versionNo: 2,
  scope: 'selected',
  targetCount: 2,
  note: null,
  originRequestId: null,
  blastedBy: 1,
  blastedAt: '2026-01-01T00:00:00.000Z',
  targets: [
    {
      id: 1,
      countryId: 2,
      countryCode: 'MY',
      countryName: 'Malaysia',
      status: 'delivered',
      failureReason: null,
    },
  ],
};

const preview: BlastPreviewResponse = {
  entityType: 'rule',
  entityId: 1,
  versionId: 10,
  versionNo: 2,
  isBreaking: false,
  countries: [
    {
      countryId: 2,
      countryCode: 'MY',
      countryName: 'Malaysia',
      currentVersionNo: 1,
      willReceiveVersionNo: 2,
      activeCampaignsOnCurrentVersion: 0,
      isBreaking: false,
    },
  ],
};

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

describe('useBlastsQuery', () => {
  it('fetches the list and resolves with the parsed page', async () => {
    mockGet.mockResolvedValue({
      data: { data: [blast], meta: { page: 1, pageSize: 50, total: 1 } },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useBlastsQuery({ pageSize: 50 }), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.data).toEqual([blast]);
  });

  it('stays disabled (no request) when `enabled` is false — TC-16/TC-17 gate this at the caller', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useBlastsQuery({}, false), { wrapper: wrapper(client) });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe('useBlastQuery', () => {
  it('fetches a single blast, keyed independently from the list', async () => {
    mockGet.mockResolvedValue({ data: { data: blast } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useBlastQuery(700), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(blast);
    expect(mockGet).toHaveBeenCalledWith('/blasts/700');
    expect(blastQueryKey(700)).not.toEqual(blastsQueryKey());
  });
});

describe('usePreviewBlastMutation', () => {
  it('previews a blast (TC-19/TC-20) without touching the blasts cache', async () => {
    mockPost.mockResolvedValue({ data: { data: preview } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => usePreviewBlastMutation(), { wrapper: wrapper(client) });
    result.current.mutate({
      entityType: 'rule',
      entityId: 1,
      versionId: 10,
      scope: 'selected',
      countryIds: [2],
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(preview);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('useCreateBlastMutation', () => {
  it('creates a blast (TC-7/TC-8) and invalidates blasts, versions and countries on success', async () => {
    mockPost.mockResolvedValue({ data: { data: blast } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useCreateBlastMutation(), { wrapper: wrapper(client) });
    result.current.mutate({
      entityType: 'rule',
      entityId: 1,
      versionId: 10,
      scope: 'selected',
      countryIds: [2],
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['blasts'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['versions'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['countries'] });
  });
});
