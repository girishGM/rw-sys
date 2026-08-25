/**
 * T-041 — the `useQuery`/`useMutation` wrappers in `api.ts`. `api.test.ts` covers the plain
 * `fetch*`/`createDraft`/`updateDraft`/`transition`/`withdrawVersionFromCountry` functions
 * directly (the actual request shape, response parsing, error mapping); this file covers the
 * thin hook layer around them — query keys wired correctly, and each mutation's `onSuccess`
 * invalidation behaviour — which a mocked `./api` module (as `VersionsPanel.test.tsx`,
 * `EditVersionDraftModal.test.tsx`, `VersionDiffViewer.test.tsx` and `BlastDialog.test.tsx` all
 * use) never exercises. Follows the exact pattern `features/countries/api.hooks.test.tsx`
 * (T-030) established.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { RuleVersion, VersionCountryAssignment, VersionDiff } from '@reward-portal/shared';

const { mockGet, mockPost, mockPatch, mockDelete } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPatch: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock('../../lib/apiClient', () => ({
  api: { get: mockGet, post: mockPost, patch: mockPatch, delete: mockDelete },
}));

import {
  versionCountriesQueryKey,
  versionDiffQueryKey,
  versionsQueryKey,
  useCreateDraftMutation,
  useUpdateDraftMutation,
  useVersionCountriesQuery,
  useVersionDiffQuery,
  useVersionTransitionMutation,
  useVersionsQuery,
  useWithdrawVersionMutation,
} from './api';

const ruleVersion: RuleVersion = {
  id: 10,
  ruleId: 1,
  versionNo: 2,
  expression: 'amount >= :minSpend',
  parameters: { fields: [] },
  changeSummary: null,
  isBreaking: false,
  status: 'published',
  supersedesVersionId: null,
  originRequestId: null,
  createdBy: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  publishedBy: 1,
  publishedAt: '2026-01-01T00:00:00.000Z',
  deprecatedAt: null,
  retiredAt: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  suggestedIsBreaking: null,
};

const diff: VersionDiff = {
  versionId: 11,
  otherVersionId: 10,
  versionNo: 3,
  otherVersionNo: 2,
  expressionChanged: true,
  parametersAdded: [],
  parametersRemoved: ['minSpend'],
  parametersTypeChanged: [],
  suggestedIsBreaking: true,
};

const countryAssignment: VersionCountryAssignment = {
  id: 900,
  versionId: 10,
  versionNo: 2,
  countryId: 2,
  countryCode: 'MY',
  countryName: 'Malaysia',
  blastId: 700,
  status: 'active',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  assignedBy: 1,
  assignedAt: '2026-01-01T00:00:00.000Z',
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
  mockDelete.mockReset();
});

describe('useVersionsQuery', () => {
  it('fetches the list for the given entity and resolves with the parsed data', async () => {
    mockGet.mockResolvedValue({ data: { data: [ruleVersion] } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useVersionsQuery('rule', 1), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([ruleVersion]);
    expect(mockGet).toHaveBeenCalledWith('/rules/1/versions');
  });
});

describe('useCreateDraftMutation', () => {
  it('creates a draft (TC-1) and invalidates the versions list on success', async () => {
    mockPost.mockResolvedValue({ data: { data: ruleVersion } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useCreateDraftMutation('rule', 1), {
      wrapper: wrapper(client),
    });
    result.current.mutate({ changeSummary: 'Adds a tier' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: versionsQueryKey('rule', 1) });
  });
});

describe('useUpdateDraftMutation', () => {
  it('edits a draft (TC-3) and invalidates the versions list on success', async () => {
    mockPatch.mockResolvedValue({ data: { data: { ...ruleVersion, changeSummary: 'Edited' } } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateDraftMutation('rule', 1, 10), {
      wrapper: wrapper(client),
    });
    result.current.mutate({ changeSummary: 'Edited' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPatch).toHaveBeenCalledWith('/rules/1/versions/10', { changeSummary: 'Edited' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: versionsQueryKey('rule', 1) });
  });
});

describe('useVersionTransitionMutation', () => {
  it('publishes a draft (TC-5) and invalidates the versions list on success', async () => {
    mockPost.mockResolvedValue({ data: { data: { ...ruleVersion, status: 'published' } } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useVersionTransitionMutation('rule', 1, 'publish'), {
      wrapper: wrapper(client),
    });
    result.current.mutate(10);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPost).toHaveBeenCalledWith('/rules/1/versions/10/publish');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: versionsQueryKey('rule', 1) });
  });

  it('deprecates/retires (TC-23/TC-24) the same way, keyed by action', async () => {
    mockPost.mockResolvedValue({ data: { data: { ...ruleVersion, status: 'retired' } } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useVersionTransitionMutation('rule', 1, 'retire'), {
      wrapper: wrapper(client),
    });
    result.current.mutate(10);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPost).toHaveBeenCalledWith('/rules/1/versions/10/retire');
  });
});

describe('useVersionDiffQuery', () => {
  it('fetches the diff (TC-25/TC-26) once both version ids are known', async () => {
    mockGet.mockResolvedValue({ data: { data: diff } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useVersionDiffQuery('rule', 1, 10, 11), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(diff);
    expect(mockGet).toHaveBeenCalledWith('/rules/1/versions/10/diff/11');
  });

  it('stays disabled (no request) while either version id is null', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useVersionDiffQuery('rule', 1, null, 11), {
      wrapper: wrapper(client),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockGet).not.toHaveBeenCalled();
    expect(versionDiffQueryKey('rule', 1, 10, 11)).toEqual(['versions', 'rule', 1, 'diff', 10, 11]);
  });
});

describe('useVersionCountriesQuery', () => {
  it('fetches the country assignments for a version', async () => {
    mockGet.mockResolvedValue({ data: { data: [countryAssignment] } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useVersionCountriesQuery('rule', 1, 10), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([countryAssignment]);
    expect(mockGet).toHaveBeenCalledWith('/rules/1/versions/10/countries');
    expect(versionCountriesQueryKey('rule', 1, 10)).toEqual([
      'versions',
      'rule',
      1,
      'countries',
      10,
    ]);
  });
});

describe('useWithdrawVersionMutation', () => {
  it('withdraws a country (TC-22) and invalidates that version-countries query on success', async () => {
    mockDelete.mockResolvedValue({ status: 204 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useWithdrawVersionMutation('rule', 1, 10), {
      wrapper: wrapper(client),
    });
    result.current.mutate(2);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockDelete).toHaveBeenCalledWith('/rules/1/versions/10/countries/2');
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: versionCountriesQueryKey('rule', 1, 10),
    });
  });
});
