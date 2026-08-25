import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Merchant, MerchantActivity, MerchantStore } from '@reward-portal/shared';

const { mockGet, mockPost, mockPatch } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPatch: vi.fn(),
}));

vi.mock('../../lib/apiClient', () => ({
  api: { get: mockGet, post: mockPost, patch: mockPatch },
}));

import {
  activeCampaignsQueryKey,
  activitiesQueryKey,
  createActivity,
  createMerchant,
  createStore,
  fetchActiveCampaigns,
  fetchActivities,
  fetchMerchant,
  fetchMerchants,
  fetchStores,
  merchantQueryKey,
  merchantsQueryKey,
  storesQueryKey,
  updateMerchant,
} from './api';
import { ApiError } from '../../lib/apiError';

const merchant: Merchant = {
  id: 100,
  tenantId: 10,
  merchantCode: 'M001',
  name: 'Acme Store',
  description: null,
  contactEmail: null,
  contactPhone: null,
  website: null,
  countryCode: 'MY',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const store: MerchantStore = {
  id: 200,
  tenantId: 10,
  merchantId: 100,
  storeCode: 'S001',
  name: 'Main Store',
  address: null,
  city: null,
  state: null,
  postalCode: null,
  region: null,
  latitude: null,
  longitude: null,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const activityLink: MerchantActivity = {
  id: 300,
  tenantId: 10,
  merchantId: 100,
  activityId: 50,
  storeId: null,
  commissionRate: null,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPatch.mockReset();
});

describe('query keys', () => {
  it('merchantsQueryKey is scoped per params', () => {
    expect(merchantsQueryKey({ page: 1 })).toEqual(['merchants', { page: 1 }]);
  });

  it('merchantQueryKey is scoped per id', () => {
    expect(merchantQueryKey(100)).toEqual(['merchants', 100]);
  });

  it('activeCampaignsQueryKey/storesQueryKey/activitiesQueryKey are distinct per merchant', () => {
    expect(activeCampaignsQueryKey(100)).toEqual(['merchants', 100, 'active-campaigns']);
    expect(storesQueryKey(100)).toEqual(['merchants', 100, 'stores']);
    expect(activitiesQueryKey(100)).toEqual(['merchants', 100, 'activities']);
  });
});

describe('fetchMerchants', () => {
  it('requests /merchants with the given params, including search (TC-21)', async () => {
    mockGet.mockResolvedValue({
      data: { data: [merchant], meta: { page: 1, pageSize: 20, total: 1 } },
    });

    const result = await fetchMerchants({ page: 1, sort: 'name:asc', search: 'acme' });

    expect(mockGet).toHaveBeenCalledWith('/merchants', {
      params: { page: 1, sort: 'name:asc', search: 'acme' },
    });
    expect(result.data).toEqual([merchant]);
    expect(result.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
  });

  it('throws an ApiError when the response does not match the shared schema', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ id: 'not-a-number' }] } });
    await expect(fetchMerchants({})).rejects.toBeInstanceOf(ApiError);
  });

  it('maps a rejected request into an ApiError', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { error: { code: 'PERM_DENIED', message: 'No.' } } },
    });
    const error = await fetchMerchants({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('PERM_DENIED');
  });
});

describe('fetchMerchant', () => {
  it('requests /merchants/:id and unwraps {data}', async () => {
    mockGet.mockResolvedValue({ data: { data: merchant } });
    const result = await fetchMerchant(100);
    expect(mockGet).toHaveBeenCalledWith('/merchants/100');
    expect(result).toEqual(merchant);
  });

  it('maps a 404 (out-of-scope merchant, TC-9/TC-11) into an ApiError', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { error: { code: 'NOT_FOUND', message: 'Not found.' } } },
    });
    const error = await fetchMerchant(999).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
  });
});

describe('createMerchant', () => {
  it('posts to /merchants — no tenantId in the request (note 2)', async () => {
    mockPost.mockResolvedValue({ data: { data: merchant } });

    const result = await createMerchant({
      merchantCode: 'M001',
      name: 'Acme Store',
      countryCode: 'MY',
    });

    expect(mockPost).toHaveBeenCalledWith(
      '/merchants',
      expect.objectContaining({ merchantCode: 'M001', countryCode: 'MY' }),
    );
    expect(mockPost.mock.calls[0][1]).not.toHaveProperty('tenantId');
    expect(result).toEqual(merchant);
  });

  it('maps a duplicate-code conflict into an ApiError (TC-3)', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: { code: 'MERCHANT_CODE_EXISTS', message: 'Already exists.' } },
      },
    });

    const error = await createMerchant({
      merchantCode: 'M001',
      name: 'Acme Store',
      countryCode: 'MY',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('MERCHANT_CODE_EXISTS');
  });

  it('maps a country mismatch into an ApiError (TC-5)', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Invalid.',
            details: [{ field: 'countryCode', code: 'MERCHANT_COUNTRY_MISMATCH' }],
          },
        },
      },
    });

    const error = await createMerchant({
      merchantCode: 'M001',
      name: 'Acme Store',
      countryCode: 'SG',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
  });
});

describe('updateMerchant', () => {
  it('patches /merchants/:id and returns the updated merchant', async () => {
    mockPatch.mockResolvedValue({ data: { data: { ...merchant, status: 'inactive' } } });

    const result = await updateMerchant(100, { status: 'inactive' });

    expect(mockPatch).toHaveBeenCalledWith('/merchants/100', { status: 'inactive' });
    expect(result.status).toBe('inactive');
  });

  it('maps a deactivation-requires-confirmation error into an ApiError (TC-20)', async () => {
    mockPatch.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 422,
        data: {
          error: {
            code: 'MERCHANT_DEACTIVATION_REQUIRES_CONFIRMATION',
            message: 'Confirm required.',
            details: [{ field: 'confirm', code: 'REQUIRED' }],
          },
        },
      },
    });

    const error = await updateMerchant(100, { status: 'inactive' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('MERCHANT_DEACTIVATION_REQUIRES_CONFIRMATION');
  });

  it('sends confirm: true through untouched', async () => {
    mockPatch.mockResolvedValue({ data: { data: { ...merchant, status: 'inactive' } } });
    await updateMerchant(100, { status: 'inactive', confirm: true });
    expect(mockPatch).toHaveBeenCalledWith('/merchants/100', {
      status: 'inactive',
      confirm: true,
    });
  });
});

describe('fetchActiveCampaigns', () => {
  it('requests /merchants/:id/active-campaigns and unwraps {data} (TC-20)', async () => {
    mockGet.mockResolvedValue({
      data: { data: [{ id: 900, campaignCode: 'C900', name: 'Campaign 900', status: 'active' }] },
    });
    const result = await fetchActiveCampaigns(100);
    expect(mockGet).toHaveBeenCalledWith('/merchants/100/active-campaigns');
    expect(result).toEqual([
      { id: 900, campaignCode: 'C900', name: 'Campaign 900', status: 'active' },
    ]);
  });
});

describe('fetchStores / createStore', () => {
  it('fetchStores requests /merchants/:id/stores and unwraps {data}', async () => {
    mockGet.mockResolvedValue({ data: { data: [store] } });
    const result = await fetchStores(100);
    expect(mockGet).toHaveBeenCalledWith('/merchants/100/stores');
    expect(result).toEqual([store]);
  });

  it('createStore posts to /merchants/:id/stores (TC-12)', async () => {
    mockPost.mockResolvedValue({ data: { data: store } });
    const result = await createStore(100, { storeCode: 'S001', name: 'Main Store' });
    expect(mockPost).toHaveBeenCalledWith('/merchants/100/stores', {
      storeCode: 'S001',
      name: 'Main Store',
    });
    expect(result).toEqual(store);
  });

  it('createStore maps a duplicate store code into an ApiError', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: { code: 'MERCHANT_STORE_CODE_EXISTS', message: 'Already exists.' } },
      },
    });
    const error = await createStore(100, { storeCode: 'S001', name: 'Main Store' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
  });
});

describe('fetchActivities / createActivity', () => {
  it('fetchActivities requests /merchants/:id/activities and unwraps {data}', async () => {
    mockGet.mockResolvedValue({ data: { data: [activityLink] } });
    const result = await fetchActivities(100);
    expect(mockGet).toHaveBeenCalledWith('/merchants/100/activities');
    expect(result).toEqual([activityLink]);
  });

  it('createActivity posts to /merchants/:id/activities — tenant-wide (TC-14)', async () => {
    mockPost.mockResolvedValue({ data: { data: activityLink } });
    const result = await createActivity(100, { activityId: 50 });
    expect(mockPost).toHaveBeenCalledWith('/merchants/100/activities', { activityId: 50 });
    expect(result).toEqual(activityLink);
  });

  it('createActivity maps an already-linked conflict into an ApiError (TC-15)', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: {
          error: { code: 'MERCHANT_ACTIVITY_ALREADY_LINKED', message: 'Already linked.' },
        },
      },
    });
    const error = await createActivity(100, { activityId: 50 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
  });
});
