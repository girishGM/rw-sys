import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Blast, BlastPreviewResponse } from '@reward-portal/shared';

const { mockGet, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock('../../lib/apiClient', () => ({ api: { get: mockGet, post: mockPost } }));

import {
  blastQueryKey,
  blastsQueryKey,
  createBlast,
  fetchBlast,
  fetchBlasts,
  previewBlast,
} from './api';
import { ApiError } from '../../lib/apiError';

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

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

describe('query keys', () => {
  it('blastsQueryKey defaults to an empty params object', () => {
    expect(blastsQueryKey()).toEqual(['blasts', {}]);
  });

  it('blastQueryKey is scoped per id', () => {
    expect(blastQueryKey(700)).toEqual(['blasts', 700]);
  });
});

describe('fetchBlasts', () => {
  it('requests /blasts with the given params and returns the parsed page', async () => {
    mockGet.mockResolvedValue({
      data: { data: [blast], meta: { page: 1, pageSize: 20, total: 1 } },
    });

    const result = await fetchBlasts({ entityType: 'rule', entityId: 1 });

    expect(mockGet).toHaveBeenCalledWith('/blasts', {
      params: { entityType: 'rule', entityId: 1 },
    });
    expect(result.data).toEqual([blast]);
    expect(result.meta.total).toBe(1);
  });

  it('maps a rejected request (e.g. tenant_admin) into an ApiError (TC-17)', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { error: { code: 'PERM_DENIED', message: 'No.' } } },
    });
    const error = await fetchBlasts().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
  });
});

describe('fetchBlast', () => {
  it('requests /blasts/:id and unwraps {data}', async () => {
    mockGet.mockResolvedValue({ data: { data: blast } });
    const result = await fetchBlast(700);
    expect(mockGet).toHaveBeenCalledWith('/blasts/700');
    expect(result).toEqual(blast);
  });
});

describe('previewBlast', () => {
  it('posts to /blasts/preview and returns the per-country impact (TC-19/TC-20)', async () => {
    mockPost.mockResolvedValue({ data: { data: preview } });

    const result = await previewBlast({
      entityType: 'rule',
      entityId: 1,
      versionId: 10,
      scope: 'selected',
      countryIds: [2],
    });

    expect(mockPost).toHaveBeenCalledWith('/blasts/preview', {
      entityType: 'rule',
      entityId: 1,
      versionId: 10,
      scope: 'selected',
      countryIds: [2],
    });
    expect(result).toEqual(preview);
  });

  it('maps a draft-version preview attempt into an ApiError (TC-14-equivalent)', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 422,
        data: { error: { code: 'VERSION_NOT_PUBLISHED', message: 'Not published.' } },
      },
    });
    const error = await previewBlast({
      entityType: 'rule',
      entityId: 1,
      versionId: 10,
      scope: 'all_countries',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('VERSION_NOT_PUBLISHED');
  });
});

describe('createBlast', () => {
  it('posts to /blasts and returns the created blast (TC-7/TC-8)', async () => {
    mockPost.mockResolvedValue({ data: { data: blast } });

    const result = await createBlast({
      entityType: 'rule',
      entityId: 1,
      versionId: 10,
      scope: 'selected',
      countryIds: [2],
    });

    expect(mockPost).toHaveBeenCalledWith('/blasts', {
      entityType: 'rule',
      entityId: 1,
      versionId: 10,
      scope: 'selected',
      countryIds: [2],
    });
    expect(result).toEqual(blast);
  });

  it('maps a breaking-confirmation-required failure into an ApiError', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 422,
        data: {
          error: {
            code: 'BREAKING_CONFIRMATION_REQUIRED',
            message: 'Confirm the breaking change.',
          },
        },
      },
    });
    const error = await createBlast({
      entityType: 'rule',
      entityId: 1,
      versionId: 10,
      scope: 'all_countries',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('BREAKING_CONFIRMATION_REQUIRED');
  });
});
