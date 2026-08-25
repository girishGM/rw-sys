import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  RewardVersion,
  RuleVersion,
  UpdateRuleVersionRequest,
  VersionCountryAssignment,
  VersionDiff,
} from '@reward-portal/shared';

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
  createDraft,
  fetchVersionCountries,
  fetchVersionDiff,
  fetchVersions,
  transition,
  updateDraft,
  versionCountriesQueryKey,
  versionDiffQueryKey,
  versionsQueryKey,
  withdrawVersionFromCountry,
} from './api';
import { ApiError } from '../../lib/apiError';

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

const rewardVersion: RewardVersion = {
  id: 20,
  rewardId: 1,
  versionNo: 1,
  connectorConfig: {},
  deliveryMode: null,
  retryConfig: {},
  policiesSnapshot: null,
  unitType: null,
  unitCode: null,
  changeSummary: null,
  isBreaking: false,
  status: 'draft',
  supersedesVersionId: null,
  originRequestId: null,
  createdBy: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  publishedBy: null,
  publishedAt: null,
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

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPatch.mockReset();
  mockDelete.mockReset();
});

describe('query keys', () => {
  it('versionsQueryKey is scoped per entity type and id', () => {
    expect(versionsQueryKey('rule', 1)).toEqual(['versions', 'rule', 1, 'list']);
    expect(versionsQueryKey('reward', 1)).toEqual(['versions', 'reward', 1, 'list']);
  });

  it('versionDiffQueryKey and versionCountriesQueryKey are distinct per version pair', () => {
    expect(versionDiffQueryKey('rule', 1, 10, 11)).toEqual(['versions', 'rule', 1, 'diff', 10, 11]);
    expect(versionCountriesQueryKey('rule', 1, 10)).toEqual([
      'versions',
      'rule',
      1,
      'countries',
      10,
    ]);
  });
});

describe('fetchVersions', () => {
  it('requests /rules/:id/versions for a rule entity', async () => {
    mockGet.mockResolvedValue({ data: { data: [ruleVersion] } });
    const result = await fetchVersions('rule', 1);
    expect(mockGet).toHaveBeenCalledWith('/rules/1/versions');
    expect(result).toEqual([ruleVersion]);
  });

  it('requests /rewards/:id/versions for a reward entity', async () => {
    mockGet.mockResolvedValue({ data: { data: [rewardVersion] } });
    const result = await fetchVersions('reward', 1);
    expect(mockGet).toHaveBeenCalledWith('/rewards/1/versions');
    expect(result).toEqual([rewardVersion]);
  });

  it('throws an ApiError when the response does not match the shared schema', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ id: 'not-a-number' }] } });
    await expect(fetchVersions('rule', 1)).rejects.toBeInstanceOf(ApiError);
  });

  it('maps a rejected request into an ApiError', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { error: { code: 'PERM_DENIED', message: 'No.' } } },
    });
    const error = await fetchVersions('rule', 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('PERM_DENIED');
  });
});

describe('createDraft', () => {
  it('posts to /rules/:id/versions and returns the created draft (TC-1)', async () => {
    mockPost.mockResolvedValue({ data: { data: ruleVersion } });

    const result = await createDraft('rule', 1, { changeSummary: 'Adds a tier' });

    expect(mockPost).toHaveBeenCalledWith('/rules/1/versions', { changeSummary: 'Adds a tier' });
    expect(result).toEqual(ruleVersion);
  });

  it('maps a concurrent-draft conflict into an ApiError (TC-2)', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: { code: 'VERSION_DRAFT_ALREADY_EXISTS', message: 'Already a draft.' } },
      },
    });
    const error = await createDraft('rule', 1, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('VERSION_DRAFT_ALREADY_EXISTS');
  });
});

describe('updateDraft', () => {
  it('patches a rule draft and returns the updated version (TC-3)', async () => {
    mockPatch.mockResolvedValue({
      data: { data: { ...ruleVersion, changeSummary: 'Tweaked wording' } },
    });

    const result = await updateDraft('rule', 1, 10, { changeSummary: 'Tweaked wording' });

    expect(mockPatch).toHaveBeenCalledWith('/rules/1/versions/10', {
      changeSummary: 'Tweaked wording',
    });
    expect(result.changeSummary).toBe('Tweaked wording');
  });

  it('patches a reward draft and returns the updated version', async () => {
    mockPatch.mockResolvedValue({ data: { data: { ...rewardVersion, unitType: 'points' } } });

    const result = await updateDraft('reward', 1, 20, { unitType: 'points' });

    expect(mockPatch).toHaveBeenCalledWith('/rewards/1/versions/20', { unitType: 'points' });
    expect(result).toMatchObject({ unitType: 'points' });
  });

  it('rejects a client-supplied field the shared .strict() schema does not allow', async () => {
    // Bypasses the TS type on purpose — proving the runtime zod schema, not just the
    // compiler, rejects an out-of-contract field such as a client trying to set `status`
    // directly instead of going through publish/deprecate/retire.
    const badInput = { status: 'published' } as unknown as UpdateRuleVersionRequest;
    const error = await updateDraft('rule', 1, 10, badInput).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('maps a 409 (published, not a draft) into an ApiError (TC-4)', async () => {
    mockPatch.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: { code: 'VERSION_NOT_DRAFT', message: 'Only a draft may be edited.' } },
      },
    });
    const error = await updateDraft('rule', 1, 10, { changeSummary: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('VERSION_NOT_DRAFT');
  });
});

describe('transition', () => {
  it('publishes a rule draft (TC-5)', async () => {
    mockPost.mockResolvedValue({
      data: { data: { ...ruleVersion, status: 'published', publishedBy: 1 } },
    });

    const result = await transition('rule', 1, 10, 'publish');

    expect(mockPost).toHaveBeenCalledWith('/rules/1/versions/10/publish');
    expect(result.status).toBe('published');
  });

  it('maps publishing an already-published version into a 409 ApiError (TC-6)', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: { code: 'VERSION_ALREADY_PUBLISHED', message: 'Already published.' } },
      },
    });
    const error = await transition('rule', 1, 10, 'publish').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('VERSION_ALREADY_PUBLISHED');
  });

  it('deprecates a reward version (TC-23)', async () => {
    mockPost.mockResolvedValue({
      data: {
        data: { ...rewardVersion, status: 'deprecated', deprecatedAt: '2026-02-01T00:00:00.000Z' },
      },
    });

    const result = await transition('reward', 1, 20, 'deprecate');

    expect(mockPost).toHaveBeenCalledWith('/rewards/1/versions/20/deprecate');
    expect(result.status).toBe('deprecated');
  });

  it('retires a rule version (TC-24)', async () => {
    mockPost.mockResolvedValue({
      data: { data: { ...ruleVersion, status: 'retired', retiredAt: '2026-03-01T00:00:00.000Z' } },
    });

    const result = await transition('rule', 1, 10, 'retire');

    expect(mockPost).toHaveBeenCalledWith('/rules/1/versions/10/retire');
    expect(result.status).toBe('retired');
  });

  it('throws an ApiError when the transition response does not match the shared schema', async () => {
    mockPost.mockResolvedValue({ data: { data: { id: 'not-a-number' } } });
    const error = await transition('rule', 1, 10, 'publish').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
  });
});

describe('fetchVersionDiff', () => {
  it('requests the diff endpoint and returns the parsed diff (TC-25/TC-26)', async () => {
    mockGet.mockResolvedValue({ data: { data: diff } });
    const result = await fetchVersionDiff('rule', 1, 10, 11);
    expect(mockGet).toHaveBeenCalledWith('/rules/1/versions/10/diff/11');
    expect(result).toEqual(diff);
  });
});

describe('fetchVersionCountries', () => {
  it('requests the version-countries endpoint', async () => {
    mockGet.mockResolvedValue({ data: { data: [countryAssignment] } });
    const result = await fetchVersionCountries('rule', 1, 10);
    expect(mockGet).toHaveBeenCalledWith('/rules/1/versions/10/countries');
    expect(result).toEqual([countryAssignment]);
  });
});

describe('withdrawVersionFromCountry', () => {
  it('deletes the version-country assignment (TC-22)', async () => {
    mockDelete.mockResolvedValue({ status: 204 });
    await withdrawVersionFromCountry('rule', 1, 10, 2);
    expect(mockDelete).toHaveBeenCalledWith('/rules/1/versions/10/countries/2');
  });

  it('maps a 422 (campaigns still bound) into an ApiError (TC-21)', async () => {
    mockDelete.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 422,
        data: {
          error: {
            code: 'VERSION_HAS_CAMPAIGNS',
            message: 'Still bound.',
            details: [{ field: 'campaignId', code: 'CAMPAIGN_55' }],
          },
        },
      },
    });
    const error = await withdrawVersionFromCountry('rule', 1, 10, 2).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('VERSION_HAS_CAMPAIGNS');
  });
});
