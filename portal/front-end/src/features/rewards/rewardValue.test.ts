/**
 * T-120 — the network half of `rewardValue.ts`, tested the way `api.test.ts` tests its own
 * fetchers: a mocked `lib/apiClient`, and an assertion that every response is **parsed** rather
 * than cast, so a server/SPA contract drift surfaces here as a caught error instead of as an
 * `undefined` deep inside a form.
 *
 * The pure `buildValueConfig`/`draftFromVersion` half is covered in `RewardValueEditor.test.tsx`
 * alongside the editors that call it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));

vi.mock('../../lib/apiClient', () => ({ api: { get: mockGet, post: mockPost } }));

import {
  createRewardVersionDraft,
  fetchRewardCategories,
  fetchRewardSubCategories,
  fetchTenantCurrencies,
  rewardCategoriesQueryKey,
  rewardSubCategoriesQueryKey,
  tenantCurrenciesQueryKey,
} from './rewardValue';
import { ApiError } from '../../lib/apiError';

const category = { id: 7, categoryCode: 'CASHBACK', name: 'Cashback', status: 'active' };
const subCategory = {
  id: 21,
  categoryId: 7,
  subCategoryCode: 'INSTANT',
  name: 'Instant',
  status: 'active',
};
const tenantCurrency = {
  id: 1,
  tenantId: 3,
  currencyCode: 'MYR',
  isDefault: true,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const rewardVersion = {
  id: 900,
  rewardId: 1,
  versionNo: 1,
  connectorConfig: {},
  deliveryMode: 'realtime',
  retryConfig: {},
  policiesSnapshot: null,
  unitType: null,
  unitCode: null,
  changeSummary: null,
  isBreaking: false,
  status: 'draft',
  supersedesVersionId: null,
  originRequestId: null,
  createdBy: 4,
  createdAt: '2026-01-01T00:00:00.000Z',
  publishedBy: null,
  publishedAt: null,
  deprecatedAt: null,
  retiredAt: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  suggestedIsBreaking: null,
  rewardKind: 'POINTS',
  valueConfig: { points: 100 },
};

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

describe('query keys', () => {
  it("matches CategoryManager's own keys, so a category created there shows up here with no reload", () => {
    expect(rewardCategoriesQueryKey()).toEqual(['reward-categories']);
    expect(rewardSubCategoriesQueryKey()).toEqual(['reward-sub-categories', null]);
    expect(rewardSubCategoriesQueryKey(7)).toEqual(['reward-sub-categories', 7]);
  });

  it('keys tenant currencies by tenant', () => {
    expect(tenantCurrenciesQueryKey(3)).toEqual(['tenants', 3, 'currencies']);
  });
});

describe('fetchRewardCategories', () => {
  it('parses the envelope', async () => {
    mockGet.mockResolvedValue({ data: { data: [category] } });
    await expect(fetchRewardCategories()).resolves.toEqual([category]);
    expect(mockGet).toHaveBeenCalledWith('/reward-categories');
  });

  it('rejects a response that does not match the contract, naming the field that broke it', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ id: 'seven' }] } });

    const error = await fetchRewardCategories().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    // Assert *why* it was rejected, the discipline `api.test.ts` adopted in T-133: a bare
    // "it threw" would still pass if the schema check were removed entirely.
    expect(String((error as ApiError).cause)).toContain('categoryCode');
  });

  it('maps a transport failure to an ApiError', async () => {
    mockGet.mockRejectedValue(new Error('network down'));
    await expect(fetchRewardCategories()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('fetchRewardSubCategories', () => {
  it('sends categoryId as a query parameter when one is given, and none when it is not', async () => {
    mockGet.mockResolvedValue({ data: { data: [subCategory] } });

    await expect(fetchRewardSubCategories(7)).resolves.toEqual([subCategory]);
    expect(mockGet).toHaveBeenLastCalledWith('/reward-sub-categories', {
      params: { categoryId: 7 },
    });

    await fetchRewardSubCategories();
    expect(mockGet).toHaveBeenLastCalledWith('/reward-sub-categories', { params: {} });
  });

  it('rejects a malformed row, naming the missing field', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ id: 1 }] } });

    const error = await fetchRewardSubCategories(7).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(String((error as ApiError).cause)).toContain('subCategoryCode');
  });
});

describe('fetchTenantCurrencies', () => {
  it('reads the tenant it was asked for (T-126 §4)', async () => {
    mockGet.mockResolvedValue({ data: { data: [tenantCurrency] } });

    await expect(fetchTenantCurrencies(3)).resolves.toEqual([tenantCurrency]);
    expect(mockGet).toHaveBeenCalledWith('/tenants/3/currencies');
  });

  it('rejects a currency code the contract would not allow (3 characters, exactly)', async () => {
    mockGet.mockResolvedValue({
      data: { data: [{ ...tenantCurrency, currencyCode: 'RINGGIT' }] },
    });

    const error = await fetchTenantCurrencies(3).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(String((error as ApiError).cause)).toContain('currencyCode');
  });

  it('maps a 403 to an ApiError rather than leaking the axios error', async () => {
    mockGet.mockRejectedValue(new Error('nope'));
    await expect(fetchTenantCurrencies(3)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('createRewardVersionDraft', () => {
  it("POSTs the Kind/value pair to that reward's own versions collection", async () => {
    mockPost.mockResolvedValue({ data: { data: rewardVersion } });

    const created = await createRewardVersionDraft(1, {
      rewardKind: 'POINTS',
      valueConfig: { points: 100 },
    });

    expect(mockPost).toHaveBeenCalledWith('/rewards/1/versions', {
      rewardKind: 'POINTS',
      valueConfig: { points: 100 },
    });
    expect(created.rewardKind).toBe('POINTS');
  });

  it('refuses to send a value that does not match its kind — the request never leaves the client', async () => {
    await expect(
      createRewardVersionDraft(1, {
        rewardKind: 'POINTS',
        valueConfig: { percentage: 5 },
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('refuses a valueConfig with no kind to judge it by', async () => {
    await expect(
      createRewardVersionDraft(1, { valueConfig: { points: 100 } }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('rejects a created version that does not match the contract', async () => {
    mockPost.mockResolvedValue({ data: { data: { id: 900 } } });

    const error = await createRewardVersionDraft(1, {
      rewardKind: 'POINTS',
      valueConfig: { points: 100 },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(String((error as ApiError).cause)).toContain('versionNo');
  });
});
