import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DefinitionRequest } from '@reward-portal/shared';

const { mockGet, mockPost, mockPatch } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPatch: vi.fn(),
}));

vi.mock('../../lib/apiClient', () => ({
  api: { get: mockGet, post: mockPost, patch: mockPatch },
}));

import {
  createDefinitionRequest,
  definitionRequestQueryKey,
  definitionRequestsQueryKey,
  fetchDefinitionRequest,
  fetchDefinitionRequests,
  fulfilDefinitionRequest,
  reviewDefinitionRequest,
  updateDefinitionRequest,
  withdrawDefinitionRequest,
} from './api';
import { ApiError } from '../../lib/apiError';

const row: DefinitionRequest = {
  id: 1,
  requestType: 'new_rule',
  entityId: null,
  requestedBy: 1,
  requestingCountryId: 9,
  requestingTenantId: null,
  title: 'Weekend multiplier',
  description: 'We need a weekend multiplier rule.',
  businessJustification: null,
  desiredBy: null,
  priority: 'normal',
  status: 'submitted',
  reviewedBy: null,
  reviewedAt: null,
  reviewComment: null,
  fulfilledVersionId: null,
  fulfilledAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPatch.mockReset();
});

describe('query keys', () => {
  it('definitionRequestsQueryKey is scoped per params', () => {
    expect(definitionRequestsQueryKey({ page: 1 })).toEqual(['definition-requests', { page: 1 }]);
  });

  it('definitionRequestQueryKey is scoped per id', () => {
    expect(definitionRequestQueryKey(7)).toEqual(['definition-requests', 7]);
  });
});

describe('fetchDefinitionRequests', () => {
  it('requests /definition-requests with the given params and returns the parsed list', async () => {
    mockGet.mockResolvedValue({
      data: { data: [row], meta: { page: 1, pageSize: 20, total: 1 } },
    });

    const result = await fetchDefinitionRequests({ status: 'submitted' });

    expect(mockGet).toHaveBeenCalledWith('/definition-requests', {
      params: { status: 'submitted' },
    });
    expect(result.data).toEqual([row]);
  });

  it('throws an ApiError when the response does not match the shared schema', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ id: 'not-a-number' }] } });
    await expect(fetchDefinitionRequests({})).rejects.toBeInstanceOf(ApiError);
  });

  it('maps a rejected request into an ApiError', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { error: { code: 'PERM_DENIED', message: 'No.' } } },
    });
    const error = await fetchDefinitionRequests({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('PERM_DENIED');
  });
});

describe('fetchDefinitionRequest', () => {
  it('requests /definition-requests/:id and unwraps {data}', async () => {
    mockGet.mockResolvedValue({ data: { data: row } });
    const result = await fetchDefinitionRequest(1);
    expect(mockGet).toHaveBeenCalledWith('/definition-requests/1');
    expect(result).toEqual(row);
  });

  it('a request not visible to the caller (404) maps into an ApiError (TC-15)', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { error: { code: 'NOT_FOUND', message: 'Not found.' } } },
    });
    const error = await fetchDefinitionRequest(999).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });
});

describe('createDefinitionRequest', () => {
  it('posts to /definition-requests and returns the created row (TC-1)', async () => {
    mockPost.mockResolvedValue({ data: { data: row } });

    const result = await createDefinitionRequest({
      requestType: 'new_rule',
      title: 'Weekend multiplier',
      description: 'We need a weekend multiplier rule.',
    });

    expect(mockPost).toHaveBeenCalledWith(
      '/definition-requests',
      expect.objectContaining({ requestType: 'new_rule' }),
    );
    expect(result).toEqual(row);
  });

  it('maps a 403 (e.g. a maker) into an ApiError (TC-4)', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { error: { code: 'PERM_DENIED', message: 'No.' } } },
    });
    const error = await createDefinitionRequest({
      requestType: 'new_rule',
      title: 'Weekend multiplier',
      description: 'a description long enough',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('PERM_DENIED');
  });
});

describe('updateDefinitionRequest', () => {
  it('patches /definition-requests/:id and returns the updated row (TC-6)', async () => {
    mockPatch.mockResolvedValue({ data: { data: { ...row, title: 'New title' } } });
    const result = await updateDefinitionRequest(1, { title: 'New title' });
    expect(mockPatch).toHaveBeenCalledWith('/definition-requests/1', { title: 'New title' });
    expect(result.title).toBe('New title');
  });

  it('maps a 409 (no longer submitted) into an ApiError (TC-7)', async () => {
    mockPatch.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: { code: 'DEFINITION_REQUEST_INVALID_TRANSITION', message: 'No.' } },
      },
    });
    const error = await updateDefinitionRequest(1, { title: 'A new title' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
  });
});

describe('withdrawDefinitionRequest', () => {
  it('posts to /definition-requests/:id/withdraw (TC-8)', async () => {
    mockPost.mockResolvedValue({ data: { data: { ...row, status: 'withdrawn' } } });
    const result = await withdrawDefinitionRequest(1);
    expect(mockPost).toHaveBeenCalledWith('/definition-requests/1/withdraw');
    expect(result.status).toBe('withdrawn');
  });
});

describe('reviewDefinitionRequest', () => {
  it('posts to /definition-requests/:id/review (TC-9)', async () => {
    mockPost.mockResolvedValue({ data: { data: { ...row, status: 'under_review' } } });
    const result = await reviewDefinitionRequest(1, { status: 'under_review' });
    expect(mockPost).toHaveBeenCalledWith('/definition-requests/1/review', {
      status: 'under_review',
    });
    expect(result.status).toBe('under_review');
  });

  it('maps a 400 (rejection with no comment) into an ApiError (TC-10)', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'No.',
            details: [{ field: 'reviewComment', code: 'REQUIRED' }],
          },
        },
      },
    });
    const error = await reviewDefinitionRequest(1, { status: 'rejected' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('VALIDATION_FAILED');
  });
});

describe('fulfilDefinitionRequest', () => {
  it('posts to /definition-requests/:id/fulfil (TC-13)', async () => {
    mockPost.mockResolvedValue({
      data: { data: { ...row, status: 'fulfilled', fulfilledVersionId: 10 } },
    });
    const result = await fulfilDefinitionRequest(1, { versionId: 10 });
    expect(mockPost).toHaveBeenCalledWith('/definition-requests/1/fulfil', { versionId: 10 });
    expect(result.fulfilledVersionId).toBe(10);
  });

  it('maps a 422 (draft version) into an ApiError (TC-14)', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 422,
        data: {
          error: { code: 'DEFINITION_REQUEST_VERSION_NOT_PUBLISHED', message: 'No.' },
        },
      },
    });
    const error = await fulfilDefinitionRequest(1, { versionId: 10 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('DEFINITION_REQUEST_VERSION_NOT_PUBLISHED');
  });
});
