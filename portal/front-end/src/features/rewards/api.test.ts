import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createRewardRequestSchema,
  rewardListItemSchema,
  rewardSchema,
  type CreateRewardRequest,
  type Reward,
  type RewardCountryAssignment,
  type RewardListItem,
  type RewardPolicy,
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

/** T-133 — `categoryId`/`categoryName`/`subCategoryId`/`subCategoryName` are part of every
 * `/rewards` response since T-118 (`reward_systems.category_id` is `NOT NULL`, and
 * `reward-response.dto.ts` resolves both names off the eagerly-loaded associations). A fixture
 * without them is a shape the server cannot produce, so this one carries a resolved
 * sub-category; `listRow` below covers the `subCategoryId: null` branch. */
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
  categoryId: 4,
  categoryName: 'Cashback',
  subCategoryId: 9,
  subCategoryName: 'Instant cashback',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** One `GET /rewards` row — no `connectorConfigPreview` key at all (TC-11), and the
 * "category with no sub-category" branch T-116 documents ("Points never needs one"). */
const listRow: RewardListItem = {
  id: 1,
  systemCode: 'POINTS_STANDARD',
  name: 'Standard points',
  description: null,
  rewardType: 'points',
  deliveryMode: 'realtime',
  connectorType: 'internal_api',
  maintenanceWindowEnabled: false,
  maintenanceSchedule: {},
  retryEnabled: true,
  retryConfig: {},
  merchantId: null,
  categoryId: 7,
  categoryName: 'Points',
  subCategoryId: null,
  subCategoryName: null,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** The minimum body `POST /rewards` accepts — `categoryId` included, required since T-118. */
const createRewardInput: CreateRewardRequest = {
  systemCode: 'CASHBACK_STANDARD',
  name: 'Standard cashback',
  rewardType: 'monetary',
  connectorType: 'internal_api',
  categoryId: 4,
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

/** T-133 regression guard. The defect this task fixes was a *type-level* one — the fixtures
 * below stopped matching the shared schema after T-118 added the category fields — and a
 * type-level break is invisible to `npm test`: `tsc` catches it, Vitest's esbuild transform
 * strips the annotation and runs anyway. These cases re-judge each fixture with the same zod
 * schema the API client uses at runtime, so the drift fails the test suite too, not only the
 * workspace typecheck. If a future schema change makes a fixture unproducible by the server
 * again, this goes red first. */
describe('fixtures match the published contract (T-133)', () => {
  it('the detail fixture parses as a Reward', () => {
    expect(rewardSchema.parse(reward)).toEqual(reward);
  });

  it('the list fixture parses as a RewardListItem', () => {
    expect(rewardListItemSchema.parse(listRow)).toEqual(listRow);
  });

  it('the create-reward fixture parses as a CreateRewardRequest', () => {
    expect(createRewardRequestSchema.parse(createRewardInput)).toEqual(createRewardInput);
  });

  it('every T-118 category field is actually present on the fixtures', () => {
    // Named explicitly: `.parse()` above would still pass if a later schema change made these
    // optional again, and the point of the fixture is that it mirrors what the server sends.
    expect(reward).toMatchObject({
      categoryId: expect.any(Number),
      categoryName: expect.any(String),
      subCategoryId: expect.any(Number),
      subCategoryName: expect.any(String),
    });
    // The other branch: a category with no sub-category resolves both sub-category fields to null.
    expect(listRow).toMatchObject({
      categoryId: expect.any(Number),
      categoryName: expect.any(String),
      subCategoryId: null,
      subCategoryName: null,
    });
    expect(createRewardInput).toMatchObject({ categoryId: expect.any(Number) });
  });
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
        data: [listRow],
        meta: { page: 1, pageSize: 20, total: 1 },
      },
    });

    const result = await fetchRewards({ page: 1, sort: 'name:asc' });

    expect(mockGet).toHaveBeenCalledWith('/rewards', { params: { page: 1, sort: 'name:asc' } });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toEqual(listRow);
  });

  it('T-158 — a legacy connectorType on one row no longer fails the whole list', async () => {
    // Filed from a live product report: a `super_admin`'s unscoped `GET /rewards` includes
    // `reward_systems` rows an e2e fixture wrote directly (bypassing `POST /rewards`'s own
    // validation) with `connector_type = 'internal'` — a pre-rename value the current
    // `REWARD_CONNECTOR_TYPES` enum no longer has. Before the fix, `rewardListItemSchema`'s
    // `connectorType` used the same closed enum on read as on write, so this whole response
    // failed `.safeParse` and `fetchRewards` threw the plain `Error` that
    // `RewardsListPage.tsx` then rendered as the generic `UNKNOWN_ERROR_MESSAGE` — reproduced
    // live in a real browser (T-158's completion report), not just here.
    const legacyRow = { ...listRow, connectorType: 'internal' };
    mockGet.mockResolvedValue({
      data: { data: [listRow, legacyRow], meta: { page: 1, pageSize: 20, total: 2 } },
    });

    const result = await fetchRewards({});

    expect(result.data).toHaveLength(2);
    expect(result.data[1].connectorType).toBe('internal');
  });

  it('rejects a list row that carries connectorConfigPreview — TC-11 is a contract test too', async () => {
    // `reward` (the detail fixture) carries `connectorConfigPreview`; spreading it into a list
    // row is exactly the shape a server bug would produce, and `rewardListItemSchema`'s
    // `.strict()` must reject it (TC-11: the key does not exist on a list row at all).
    mockGet.mockResolvedValue({
      data: { data: [reward], meta: { page: 1, pageSize: 20, total: 1 } },
    });
    const error = await fetchRewards({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    // T-133: assert *why* it was rejected. Until this task, the fixture was also missing the
    // four T-118 category fields, so this test passed on "required field absent" and would
    // have stayed green even if `.strict()` were dropped — a change-detector, not a test.
    expect(String((error as ApiError).cause)).toContain('connectorConfigPreview');
    expect(String((error as ApiError).cause)).toContain('unrecognized_keys');
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

    const result = await createReward(createRewardInput);

    expect(mockPost).toHaveBeenCalledWith(
      '/rewards',
      expect.objectContaining({ systemCode: 'CASHBACK_STANDARD', categoryId: 4 }),
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

    const error = await createReward({ ...createRewardInput, systemCode: 'XX', name: 'x' }).catch(
      (e: unknown) => e,
    );
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

    const error = await createReward({ ...createRewardInput, systemCode: 'XX', name: 'x' }).catch(
      (e: unknown) => e,
    );
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
