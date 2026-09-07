/**
 * T-RR-022 — `RewardSystemResolutionService`. Unit-tested against a fake `CampaignConfigCache`
 * (the gRPC round trip is already covered in `campaign-config.client.spec.ts`; the TTL/keying
 * behaviour in `campaign-config.cache.spec.ts` — this file isolates the level/ref_id matching
 * logic itself, this task's own most safety-critical piece per its own note 4).
 */
import {
  RewardNotFoundInCampaignConfigError,
  RewardSystemResolutionService,
} from '@/modules/processing/reward-system-resolution.service';
import type { CampaignConfigCache } from '@/modules/processing/campaign-config.cache';
import type { CampaignConfigProto } from '@/modules/processing/campaign-config.client';

function buildConfig(overrides: Partial<CampaignConfigProto> = {}): CampaignConfigProto {
  return {
    campaignId: 1,
    campaignCode: 'CAMP1',
    tenantId: 1,
    countryId: 1,
    status: 'active',
    startDate: '2026-01-01T00:00:00.000Z',
    endDate: '2026-12-31T00:00:00.000Z',
    budget: { amount: '1000.00', currency: 'USD' },
    maxParticipants: 100,
    merchants: [],
    trackers: [
      {
        trackerId: 100,
        trackerCode: 'TRK1',
        name: 'Tracker One',
        completionLogic: 'all',
        completionThreshold: 1,
        status: 'active',
        components: [
          {
            componentId: 1000,
            componentCode: 'COMP1',
            name: 'Component One',
            activityId: 10,
            sequenceOrder: 1,
            isMandatory: true,
            status: 'active',
          },
        ],
      },
    ],
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

function build(config: CampaignConfigProto): {
  service: RewardSystemResolutionService;
  get: jest.Mock;
} {
  const get = jest.fn().mockResolvedValue(config);
  const cache = { get } as unknown as CampaignConfigCache;
  return { service: new RewardSystemResolutionService(cache), get };
}

describe('T-RR-022 — RewardSystemResolutionService', () => {
  // TC-1.
  it('TC-1: resolves a campaign-level BoundReward (ref_id = 0) by system_code', async () => {
    const config = buildConfig({
      rewards: [
        {
          rewardId: 1,
          rewardVersionId: 1,
          versionNo: 1,
          systemCode: 'PROMO_CODE_SERVICE',
          rewardType: 'VOUCHER',
          deliveryMode: 'API',
          policiesJson: '{}',
          unitType: 'voucher',
          unitCode: 'VOUCHER_10',
          level: 'campaign',
          refId: 0,
          status: 'active',
          // T-RR-063: a real duration set on this BoundReward -- must thread through untouched.
          expiryValue: 15,
          expiryUnit: 'minutes',
        },
      ],
    });
    const { service, get } = build(config);

    const result = await service.resolve({
      tenantId: 1,
      campaignCode: 'CAMP1',
      trackerCode: 'TRK1',
      trackerComponentCode: 'COMP1',
      rewardCode: 'PROMO_CODE_SERVICE',
    });

    expect(get).toHaveBeenCalledWith(1, 'CAMP1');
    expect(result).toEqual({
      systemCode: 'PROMO_CODE_SERVICE',
      rewardType: 'VOUCHER',
      deliveryMode: 'API',
      unitType: 'voucher',
      unitCode: 'VOUCHER_10',
      level: 'campaign',
      refId: 0,
      versionNo: 1,
      status: 'active',
      expiryValue: 15,
      expiryUnit: 'minutes',
    });
  });

  // T-RR-063.
  it("T-RR-063: BoundReward's proto 0/'' expiry sentinel resolves to null/null (never expires), not 0/''", async () => {
    const config = buildConfig({
      rewards: [
        {
          rewardId: 5,
          rewardVersionId: 1,
          versionNo: 1,
          systemCode: 'CASHBACK_NO_EXPIRY',
          rewardType: 'CASHBACK',
          deliveryMode: 'API',
          policiesJson: '{}',
          unitType: 'currency',
          unitCode: 'MYR',
          level: 'campaign',
          refId: 0,
          status: 'active',
          expiryValue: 0,
          expiryUnit: '',
        },
      ],
    });
    const { service } = build(config);

    const result = await service.resolve({
      tenantId: 1,
      campaignCode: 'CAMP1',
      trackerCode: 'TRK1',
      trackerComponentCode: 'COMP1',
      rewardCode: 'CASHBACK_NO_EXPIRY',
    });

    expect(result.expiryValue).toBeNull();
    expect(result.expiryUnit).toBeNull();
  });

  // TC-2.
  it("TC-2: resolves a tracker-level BoundReward by joining trackerCode -> the feed's own trackerId, not a direct string match", async () => {
    const config = buildConfig({
      rewards: [
        {
          rewardId: 2,
          rewardVersionId: 1,
          versionNo: 1,
          systemCode: 'CORE_BANKING',
          rewardType: 'CASHBACK',
          deliveryMode: 'API',
          policiesJson: '{}',
          unitType: 'currency',
          unitCode: 'MYR',
          level: 'tracker',
          refId: 100, // the feed's own numeric trackerId for TRK1 — NOT the string "TRK1"
          status: 'active',
          expiryValue: 0,
          expiryUnit: '',
        },
      ],
    });
    const { service } = build(config);

    const result = await service.resolve({
      tenantId: 1,
      campaignCode: 'CAMP1',
      trackerCode: 'TRK1',
      trackerComponentCode: 'COMP1',
      rewardCode: 'CORE_BANKING',
    });

    expect(result.level).toBe('tracker');
    expect(result.refId).toBe(100);
  });

  it("resolves a component-level BoundReward by joining trackerComponentCode -> the feed's own componentId", async () => {
    const config = buildConfig({
      rewards: [
        {
          rewardId: 3,
          rewardVersionId: 1,
          versionNo: 1,
          systemCode: 'POINTS_LEDGER',
          rewardType: 'POINTS',
          deliveryMode: 'INTERNAL',
          policiesJson: '{}',
          unitType: 'points',
          unitCode: 'PTS',
          level: 'component',
          refId: 1000,
          status: 'active',
          expiryValue: 0,
          expiryUnit: '',
        },
      ],
    });
    const { service } = build(config);

    const result = await service.resolve({
      tenantId: 1,
      campaignCode: 'CAMP1',
      trackerCode: 'TRK1',
      trackerComponentCode: 'COMP1',
      rewardCode: 'POINTS_LEDGER',
    });

    expect(result.level).toBe('component');
    expect(result.refId).toBe(1000);
  });

  it('does not confuse a tracker-level reward with a same-system_code reward bound at a different tracker', async () => {
    const config = buildConfig({
      trackers: [
        {
          trackerId: 100,
          trackerCode: 'TRK1',
          name: 'Tracker One',
          completionLogic: 'all',
          completionThreshold: 1,
          status: 'active',
          components: [],
        },
        {
          trackerId: 200,
          trackerCode: 'TRK2',
          name: 'Tracker Two',
          completionLogic: 'all',
          completionThreshold: 1,
          status: 'active',
          components: [],
        },
      ],
      rewards: [
        {
          rewardId: 4,
          rewardVersionId: 1,
          versionNo: 1,
          systemCode: 'SAME_CODE',
          rewardType: 'CASHBACK',
          deliveryMode: 'API',
          policiesJson: '{}',
          unitType: 'currency',
          unitCode: 'MYR',
          level: 'tracker',
          refId: 200, // bound to TRK2, not TRK1
          status: 'active',
          expiryValue: 0,
          expiryUnit: '',
        },
      ],
    });
    const { service } = build(config);

    await expect(
      service.resolve({
        tenantId: 1,
        campaignCode: 'CAMP1',
        trackerCode: 'TRK1',
        trackerComponentCode: '',
        rewardCode: 'SAME_CODE',
      }),
    ).rejects.toBeInstanceOf(RewardNotFoundInCampaignConfigError);
  });

  // TC-5.
  it('TC-5: throws a named error, never returns undefined/a guessed system_code, when no BoundReward matches', async () => {
    const config = buildConfig({ rewards: [] });
    const { service } = build(config);

    await expect(
      service.resolve({
        tenantId: 1,
        campaignCode: 'CAMP1',
        trackerCode: 'TRK1',
        trackerComponentCode: 'COMP1',
        rewardCode: 'NOT_A_REAL_REWARD',
      }),
    ).rejects.toThrow(RewardNotFoundInCampaignConfigError);
  });
});
