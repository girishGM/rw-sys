/**
 * T-RR-022 — `CampaignConfigCache`. Same fake-repository/fake-`ServiceConfigCache` unit-test shape
 * `test/tenant-schema-cache/dispatch-channel-config.cache.spec.ts` already established (confirmed
 * by direct read) — a fake `CampaignConfigClient` stands in for the network round trip (already
 * covered against a real mock gRPC server in `campaign-config.client.spec.ts`), so these tests
 * isolate the cache's own TTL/keying/invalidation behaviour.
 */
import {
  CAMPAIGN_CONFIG_TTL_KEY,
  CampaignConfigCache,
  DEFAULT_CAMPAIGN_CONFIG_TTL_MS,
} from '@/modules/processing/campaign-config.cache';
import type {
  CampaignConfigClient,
  CampaignConfigProto,
} from '@/modules/processing/campaign-config.client';
import type { ServiceConfigCache } from '@/modules/tenant-schema-cache/service-config.cache';

function buildCampaign(overrides: Partial<CampaignConfigProto> = {}): CampaignConfigProto {
  return {
    campaignId: 1,
    campaignCode: overrides.campaignCode ?? 'CAMP1',
    tenantId: overrides.tenantId ?? 1,
    countryId: 1,
    status: 'active',
    startDate: '2026-01-01T00:00:00.000Z',
    endDate: '2026-12-31T00:00:00.000Z',
    budget: { amount: '1000.00', currency: 'USD' },
    maxParticipants: 100,
    merchants: [],
    trackers: [],
    rewards: [],
    etag: 'etag-1',
    configHash: 'hash-1',
    notModified: false,
    servedAt: new Date().toISOString(),
    caps: [],
    sectionsReturned: ['BASIC', 'MERCHANTS', 'TRACKERS', 'REWARDS', 'CAPS'],
    sectionsOmitted: [],
    ...overrides,
  };
}

function build(
  ttlSeconds: number | 'throw' = 300,
  tenantIds: number[] = [1],
): {
  cache: CampaignConfigCache;
  getCampaignConfig: jest.Mock;
  listActiveCampaigns: jest.Mock;
  resolve: jest.Mock;
} {
  const getCampaignConfig = jest.fn();
  const listActiveCampaigns = jest.fn();
  const client = { getCampaignConfig, listActiveCampaigns } as unknown as CampaignConfigClient;
  const resolve =
    ttlSeconds === 'throw'
      ? jest.fn().mockRejectedValue(new Error('cache.ttl.campaignConfig.seconds not seeded'))
      : jest.fn().mockResolvedValue(ttlSeconds);
  const serviceConfigCache = { resolve } as unknown as ServiceConfigCache;
  const cache = new CampaignConfigCache(client, serviceConfigCache, tenantIds);
  return { cache, getCampaignConfig, listActiveCampaigns, resolve };
}

describe('T-RR-022 — CampaignConfigCache', () => {
  // TC-1 / TC-3.
  it('TC-1/TC-3: a second read of the same (tenantId, campaignCode) within TTL is served from cache, no second gRPC call', async () => {
    const { cache, getCampaignConfig } = build();
    getCampaignConfig.mockResolvedValue(buildCampaign());

    const first = await cache.get(1, 'CAMP1');
    const second = await cache.get(1, 'CAMP1');

    expect(first).toEqual(second);
    expect(getCampaignConfig).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the cached entry has expired', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(3_000_000);
    const { cache, getCampaignConfig } = build(1);
    getCampaignConfig.mockResolvedValue(buildCampaign());

    await cache.get(1, 'CAMP1');
    nowSpy.mockReturnValue(3_000_000 + 1_001);
    await cache.get(1, 'CAMP1');

    expect(getCampaignConfig).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('does not conflate two different campaigns for the same tenant, or the same campaign code across tenants', async () => {
    const { cache, getCampaignConfig } = build();
    getCampaignConfig
      .mockResolvedValueOnce(buildCampaign({ campaignCode: 'CAMP1', tenantId: 1 }))
      .mockResolvedValueOnce(buildCampaign({ campaignCode: 'CAMP2', tenantId: 1 }))
      .mockResolvedValueOnce(buildCampaign({ campaignCode: 'CAMP1', tenantId: 2 }));

    const a = await cache.get(1, 'CAMP1');
    const b = await cache.get(1, 'CAMP2');
    const c = await cache.get(2, 'CAMP1');

    expect(a.campaignCode).toBe('CAMP1');
    expect(b.campaignCode).toBe('CAMP2');
    expect(c.tenantId).toBe(2);
    expect(getCampaignConfig).toHaveBeenCalledTimes(3);
  });

  // TC-4.
  it('TC-4: invalidateOne clears only the named (tenantId, campaignCode) — a different cached campaign for the same tenant stays cached', async () => {
    const { cache, getCampaignConfig } = build();
    getCampaignConfig
      .mockResolvedValueOnce(buildCampaign({ campaignCode: 'CAMP1', tenantId: 1 }))
      .mockResolvedValueOnce(buildCampaign({ campaignCode: 'CAMP2', tenantId: 1 }))
      .mockResolvedValueOnce(buildCampaign({ campaignCode: 'CAMP1', tenantId: 1 }));

    await cache.get(1, 'CAMP1');
    await cache.get(1, 'CAMP2');

    cache.invalidateOne(1, 'CAMP1');

    await cache.get(1, 'CAMP1'); // re-fetched (3rd call)
    await cache.get(1, 'CAMP2'); // still cached, no further call

    expect(getCampaignConfig).toHaveBeenCalledTimes(3);
  });

  it('invalidate() with no arguments clears every cached campaign for every tenant', async () => {
    const { cache, getCampaignConfig } = build();
    getCampaignConfig.mockResolvedValue(buildCampaign());

    await cache.get(1, 'CAMP1');
    cache.invalidate();
    await cache.get(1, 'CAMP1');

    expect(getCampaignConfig).toHaveBeenCalledTimes(2);
  });

  it('resolves its own TTL from cache.ttl.campaignConfig.seconds via ServiceConfigCache', async () => {
    const { cache, getCampaignConfig, resolve } = build(42);
    getCampaignConfig.mockResolvedValue(buildCampaign());

    await cache.get(1, 'CAMP1');

    expect(resolve).toHaveBeenCalledWith(CAMPAIGN_CONFIG_TTL_KEY, 'int', {});
  });

  it('falls back to the compiled-in default TTL when the key is not yet seeded, mirroring ReconciliationPollerService', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { cache, getCampaignConfig } = build('throw');
    getCampaignConfig.mockResolvedValue(buildCampaign());

    await cache.get(1, 'CAMP1');
    // Still within the default TTL window — no second gRPC call yet.
    nowSpy.mockReturnValue(1_000_000 + DEFAULT_CAMPAIGN_CONFIG_TTL_MS - 1);
    await cache.get(1, 'CAMP1');
    expect(getCampaignConfig).toHaveBeenCalledTimes(1);

    // Past the default TTL window — re-fetches.
    nowSpy.mockReturnValue(1_000_000 + DEFAULT_CAMPAIGN_CONFIG_TTL_MS + 1);
    await cache.get(1, 'CAMP1');
    expect(getCampaignConfig).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it('refreshAll() wholesale re-fetches every active campaign for every configured tenant', async () => {
    const { cache, listActiveCampaigns, getCampaignConfig } = build(300, [1, 2]);
    listActiveCampaigns
      .mockResolvedValueOnce({ campaigns: [buildCampaign({ campaignCode: 'CAMP1', tenantId: 1 })] })
      .mockResolvedValueOnce({
        campaigns: [buildCampaign({ campaignCode: 'CAMP2', tenantId: 2 })],
      });

    await cache.refreshAll();

    expect(listActiveCampaigns).toHaveBeenCalledTimes(2);
    expect(listActiveCampaigns).toHaveBeenCalledWith(1);
    expect(listActiveCampaigns).toHaveBeenCalledWith(2);

    // Populated from refreshAll, no further gRPC call needed.
    await cache.get(1, 'CAMP1');
    await cache.get(2, 'CAMP2');
    expect(getCampaignConfig).not.toHaveBeenCalled();
  });
});
