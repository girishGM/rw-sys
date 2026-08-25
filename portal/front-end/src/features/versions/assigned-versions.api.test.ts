import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AssignedVersion } from '@reward-portal/shared';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock('../../lib/apiClient', () => ({ api: { get: mockGet } }));

import { assignedVersionsQueryKey, fetchAssignedVersions } from './assigned-versions.api';
import { ApiError } from '../../lib/apiError';

const assigned: AssignedVersion = {
  entityType: 'rule',
  entityId: 1,
  entityCode: 'MIN_SPEND_TIER',
  entityName: 'Minimum spend tier',
  versionId: 10,
  versionNo: 2,
  status: 'active',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
};

beforeEach(() => {
  mockGet.mockReset();
});

describe('assignedVersionsQueryKey', () => {
  it('is scoped per country id', () => {
    expect(assignedVersionsQueryKey(2)).toEqual(['countries', 2, 'assigned-versions']);
  });
});

describe('fetchAssignedVersions', () => {
  it('requests /countries/:id/assigned-versions and returns the parsed list', async () => {
    mockGet.mockResolvedValue({ data: { data: [assigned] } });
    const result = await fetchAssignedVersions(2);
    expect(mockGet).toHaveBeenCalledWith('/countries/2/assigned-versions');
    expect(result).toEqual([assigned]);
  });

  it('throws an ApiError when the response does not match the shared schema', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ entityType: 'not-valid' }] } });
    await expect(fetchAssignedVersions(2)).rejects.toBeInstanceOf(ApiError);
  });

  it('maps a rejected request (out-of-scope country) into an ApiError', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { error: { code: 'NOT_FOUND', message: 'Not found.' } } },
    });
    const error = await fetchAssignedVersions(999).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });
});
