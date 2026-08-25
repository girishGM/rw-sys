import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  MerchantCampaignDetail,
  MerchantCampaignListItem,
  MerchantSummary,
} from '@reward-portal/shared';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock('../../lib/apiClient', () => ({ api: { get: mockGet } }));

import {
  fetchMerchantCampaign,
  fetchMerchantCampaigns,
  fetchMerchantSummary,
  merchantCampaignQueryKey,
  merchantCampaignsQueryKey,
  merchantSummaryQueryKey,
} from './api';
import { ApiError } from '../../lib/apiError';

const listItem: MerchantCampaignListItem = {
  id: 1,
  campaignCode: 'CMP-1',
  name: 'Summer Splash',
  description: null,
  region: 'EU',
  startDate: '2026-01-01T00:00:00.000Z',
  endDate: '2026-02-01T00:00:00.000Z',
  status: 'active',
};

const detail: MerchantCampaignDetail = {
  ...listItem,
  maxParticipants: 10,
  participation: { status: 'active', joinedAt: '2026-01-01T00:00:00.000Z' },
  myActivities: [
    { activityId: 5, activityName: 'In-store purchase', storeId: null, commissionRate: '2.50' },
  ],
};

const summary: MerchantSummary = {
  activeCampaignsCount: 1,
  myActivitiesCount: 1,
  campaignPerformance: { available: false, reason: 'No source table yet' },
  participatingCampaigns: [listItem],
};

beforeEach(() => {
  mockGet.mockReset();
});

describe('query keys', () => {
  it('are stable, distinct tuples', () => {
    expect(merchantCampaignsQueryKey()).toEqual(['merchant-campaigns']);
    expect(merchantCampaignQueryKey(1)).toEqual(['merchant-campaigns', 1]);
    expect(merchantSummaryQueryKey()).toEqual(['merchant-summary']);
  });
});

describe('fetchMerchantCampaigns', () => {
  it('requests the list and returns the parsed data', async () => {
    mockGet.mockResolvedValue({ data: { data: [listItem] } });
    const result = await fetchMerchantCampaigns();
    expect(mockGet).toHaveBeenCalledWith('/merchant/campaigns');
    expect(result).toEqual([listItem]);
  });

  it('throws an ApiError when the response does not match the shared schema', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ id: 1 }] } });
    await expect(fetchMerchantCampaigns()).rejects.toBeInstanceOf(ApiError);
  });

  it('maps a rejected request into an ApiError (TC-16 — 403 for a non-merchant caller)', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { error: { code: 'PERM_DENIED', message: 'Forbidden' } } },
    });
    const error = await fetchMerchantCampaigns().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
  });
});

describe('fetchMerchantCampaign', () => {
  it('requests the detail by id and returns the parsed data', async () => {
    mockGet.mockResolvedValue({ data: { data: detail } });
    const result = await fetchMerchantCampaign(1);
    expect(mockGet).toHaveBeenCalledWith('/merchant/campaigns/1');
    expect(result).toEqual(detail);
  });

  it('maps a 404 (TC-3/TC-4 — no participation, or another tenant) into an ApiError', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { error: { code: 'NOT_FOUND', message: 'Not found' } } },
    });
    const error = await fetchMerchantCampaign(999).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });
});

describe('fetchMerchantSummary', () => {
  it('requests the summary and returns the parsed data, including an unavailable performance metric (TC-19)', async () => {
    mockGet.mockResolvedValue({ data: { data: summary } });
    const result = await fetchMerchantSummary();
    expect(mockGet).toHaveBeenCalledWith('/merchant/summary');
    expect(result.campaignPerformance).toEqual({
      available: false,
      reason: 'No source table yet',
    });
  });

  it('throws an ApiError when the response does not match the shared schema', async () => {
    mockGet.mockResolvedValue({ data: { data: { activeCampaignsCount: 1 } } });
    await expect(fetchMerchantSummary()).rejects.toBeInstanceOf(ApiError);
  });
});
