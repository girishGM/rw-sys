import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Reward, RewardCountryAssignment, RewardPolicy } from '@reward-portal/shared';

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
  assignRewardCountry,
  createReward,
  createRewardPolicy,
  deleteReward,
  fetchReward,
  fetchRewardCountries,
  fetchRewardPolicies,
  fetchRewards,
  rewardCountriesQueryKey,
  rewardPoliciesQueryKey,
  rewardQueryKey,
  rewardsQueryKey,
  unassignRewardCountry,
  updateReward,
  updateRewardPolicy,
} from './api';
import { ApiError } from '../../lib/apiError';

const reward: Reward = {
  id: 1,
  systemCode: 'CASHBACK_STANDARD',
  name: 'Standard cashback',
  description: null,
  rewardType: 'monetary',
  deliveryMode: 'realtime',
  connectorType: 'internal_api',
  connectorConfigPreview: null,
  maintenanceWindowEnabled: false,
  maintenanceSchedule: {},
  retryEnabled: true,
  retryConfig: {},
  merchantId: null,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const assignment: RewardCountryAssignment = {
  id: 500,
  rewardId: 1,
  countryId: 2,
  countryCode: 'SG',
  countryName: 'Singapore',
  assignedAt: '2026-01-01T00:00:00.000Z',
  assignedBy: null,
};

const policy: RewardPolicy = {
  id: 10,
  rewardSystemId: 1,
  policyCode: 'STANDARD',
  name: 'Standard policy',
  description: null,
  config: {},
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPatch.mockReset();
  mockDelete.mockReset();
});

describe('query keys', () => {
  it('rewardsQueryKey is scoped per params', () => {
    expect(rewardsQueryKey({ page: 1 })).toEqual(['rewards', { page: 1 }]);
  });

  it('rewardQueryKey is scoped per id', () => {
    expect(rewardQueryKey(7)).toEqual(['rewards', 7]);
  });

  it('rewardCountriesQueryKey and rewardPoliciesQueryKey are distinct per id', () => {
    expect(rewardCountriesQueryKey(7)).toEqual(['rewards', 7, 'countries']);
    expect(rewardPoliciesQueryKey(7)).toEqual(['rewards', 7, 'policies']);
  });
});

describe('fetchRewards', () => {
  it('requests /rewards with the given params and returns the parsed list', async () => {
    mockGet.mockResolvedValue({
      data: {
        data: [
          {
            id: 1,
            systemCode: 'CASHBACK_STANDARD',
            name: 'Standard cashback',
            description: null,
            rewardType: 'monetary',
            deliveryMode: 'realtime',
            connectorType: 'internal_api',
            maintenanceWindowEnabled: false,
            maintenanceSchedule: {},
            retryEnabled: true,
            retryConfig: {},
            merchantId: null,
            status: 'active',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        meta: { page: 1, pageSize: 20, total: 1 },
      },
    });

    const result = await fetchRewards({ page: 1, sort: 'name:asc' });

    expect(mockGet).toHaveBeenCalledWith('/rewards', { params: { page: 1, sort: 'name:asc' } });
    expect(result.data).toHaveLength(1);
  });

  it('rejects a list row that carries connectorConfigPreview — TC-11 is a contract test too', async () => {
    // `reward` (the detail fixture) carries `connectorConfigPreview`; spreading it into a list
    // row is exactly the shape a server bug would produce, and `rewardListItemSchema`'s
    // `.strict()` must reject it (TC-11: the key does not exist on a list row at all).
    mockGet.mockResolvedValue({
      data: { data: [reward], meta: { page: 1, pageSize: 20, total: 1 } },
    });
    await expect(fetchRewards({})).rejects.toBeInstanceOf(ApiError);
  });

  it('maps a rejected request into an ApiError', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { error: { code: 'PERM_DENIED', message: 'No.' } } },
    });
    const error = await fetchRewards({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('PERM_DENIED');
  });
});

describe('fetchReward', () => {
  it('requests /rewards/:id and unwraps {data}, masked connectorConfigPreview intact (TC-12)', async () => {
    const masked = { ...reward, connectorConfigPreview: { apiKey: '••••1234' } };
    mockGet.mockResolvedValue({ data: { data: masked } });
    const result = await fetchReward(1);
    expect(mockGet).toHaveBeenCalledWith('/rewards/1');
    expect(result.connectorConfigPreview).toEqual({ apiKey: '••••1234' });
  });

  it('a reward not visible to the caller (404) maps into an ApiError (TC-6)', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { error: { code: 'NOT_FOUND', message: 'Not found.' } } },
    });
    const error = await fetchReward(999).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });
});

describe('fetchRewardCountries', () => {
  it('requests /rewards/:id/countries and returns the assignment list', async () => {
    mockGet.mockResolvedValue({ data: { data: [assignment] } });
    const result = await fetchRewardCountries(1);
    expect(mockGet).toHaveBeenCalledWith('/rewards/1/countries');
    expect(result).toEqual([assignment]);
  });
});

describe('createReward', () => {
  it('posts to /rewards and returns the created reward (TC-1)', async () => {
    mockPost.mockResolvedValue({ data: { data: reward } });

    const result = await createReward({
      systemCode: 'CASHBACK_STANDARD',
      name: 'Standard cashback',
      rewardType: 'monetary',
      connectorType: 'internal_api',
    });

    expect(mockPost).toHaveBeenCalledWith(
      '/rewards',
      expect.objectContaining({ systemCode: 'CASHBACK_STANDARD' }),
    );
    expect(result).toEqual(reward);
  });

  it('maps a duplicate-code conflict into an ApiError (TC-16)', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: { code: 'REWARD_SYSTEM_CODE_EXISTS', message: 'Already exists.' } },
      },
    });

    const error = await createReward({
      systemCode: 'XX',
      name: 'x',
      rewardType: 'monetary',
      connectorType: 'internal_api',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('REWARD_SYSTEM_CODE_EXISTS');
  });

  it('maps a malformed connectorConfig failure into an ApiError (TC-15)', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Invalid.',
            details: [{ field: 'connectorConfig', code: 'IS_REWARD_CONNECTOR_CONFIG' }],
          },
        },
      },
    });

    const error = await createReward({
      systemCode: 'XX',
      name: 'x',
      rewardType: 'monetary',
      connectorType: 'internal_api',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('VALIDATION_FAILED');
  });
});

describe('updateReward', () => {
  it('patches /rewards/:id and returns the updated reward', async () => {
    mockPatch.mockResolvedValue({ data: { data: { ...reward, name: 'New name' } } });

    const result = await updateReward(1, { name: 'New name' });

    expect(mockPatch).toHaveBeenCalledWith('/rewards/1', { name: 'New name' });
    expect(result.name).toBe('New name');
  });

  it('maps a 403 (e.g. a maker) into an ApiError', async () => {
    mockPatch.mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { error: { code: 'PERM_DENIED', message: 'No.' } } },
    });
    const error = await updateReward(1, { name: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
  });
});

describe('deleteReward', () => {
  it('deletes /rewards/:id', async () => {
    mockDelete.mockResolvedValue({ status: 204 });
    await deleteReward(1);
    expect(mockDelete).toHaveBeenCalledWith('/rewards/1');
  });

  it('maps a 422 (still assigned) into an ApiError (TC-20)', async () => {
    mockDelete.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 422,
        data: { error: { code: 'REWARD_HAS_COUNTRY_ASSIGNMENTS', message: 'Unassign first.' } },
      },
    });
    const error = await deleteReward(1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('REWARD_HAS_COUNTRY_ASSIGNMENTS');
  });
});

describe('assignRewardCountry', () => {
  it('posts to /rewards/:id/countries and returns the assignment (TC-7)', async () => {
    mockPost.mockResolvedValue({ data: { data: assignment } });

    const result = await assignRewardCountry(1, { countryId: 2 });

    expect(mockPost).toHaveBeenCalledWith('/rewards/1/countries', { countryId: 2 });
    expect(result).toEqual(assignment);
  });
});

describe('unassignRewardCountry', () => {
  it('deletes /rewards/:id/countries/:countryId', async () => {
    mockDelete.mockResolvedValue({ status: 204 });
    await unassignRewardCountry(1, 2);
    expect(mockDelete).toHaveBeenCalledWith('/rewards/1/countries/2');
  });

  it('maps a 422 (bound to an active campaign) into an ApiError (TC-9)', async () => {
    mockDelete.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 422,
        data: {
          error: {
            code: 'REWARD_IN_USE_BY_CAMPAIGN',
            message: 'In use.',
            details: [{ field: 'campaignId', code: 'CAMPAIGN_55' }],
          },
        },
      },
    });
    const error = await unassignRewardCountry(1, 2).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('REWARD_IN_USE_BY_CAMPAIGN');
  });
});

describe('reward_policies', () => {
  it('fetchRewardPolicies requests /rewards/:id/policies', async () => {
    mockGet.mockResolvedValue({ data: { data: [policy] } });
    const result = await fetchRewardPolicies(1);
    expect(mockGet).toHaveBeenCalledWith('/rewards/1/policies');
    expect(result).toEqual([policy]);
  });

  it('createRewardPolicy posts to /rewards/:id/policies (TC-17)', async () => {
    mockPost.mockResolvedValue({ data: { data: policy } });
    const result = await createRewardPolicy(1, { policyCode: 'STANDARD', name: 'Standard policy' });
    expect(mockPost).toHaveBeenCalledWith('/rewards/1/policies', {
      policyCode: 'STANDARD',
      name: 'Standard policy',
    });
    expect(result).toEqual(policy);
  });

  it('createRewardPolicy maps a duplicate policyCode into an ApiError (TC-18)', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: { code: 'REWARD_POLICY_CODE_EXISTS', message: 'Already exists.' } },
      },
    });
    const error = await createRewardPolicy(1, { policyCode: 'DUP', name: 'x' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('REWARD_POLICY_CODE_EXISTS');
  });

  it('updateRewardPolicy patches /rewards/:id/policies/:policyId', async () => {
    mockPatch.mockResolvedValue({ data: { data: { ...policy, status: 'inactive' } } });
    const result = await updateRewardPolicy(1, 10, { status: 'inactive' });
    expect(mockPatch).toHaveBeenCalledWith('/rewards/1/policies/10', { status: 'inactive' });
    expect(result.status).toBe('inactive');
  });
});
