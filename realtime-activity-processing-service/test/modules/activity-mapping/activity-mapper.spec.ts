/**
 * T-RAP-021. Unit tests for `ActivityMapper` against a stub `CampaignConfigCacheService` — no
 * network, no DB. The cache's own "active campaign/tracker/component only" filtering is already
 * covered by `campaign-config-cache.service.spec.ts` (T-RAP-010's own TC-4/TC-5/TC-6); this suite
 * only proves `ActivityMapper` calls the right cache method for the right input shape and passes
 * results through unmodified (TC-1/TC-2/TC-3/TC-4/TC-5).
 */
import { ActivityMapper } from '@/modules/activity-mapping/activity-mapper';
import type {
  CampaignConfigCacheService,
  MatchedTrackerComponent,
} from '@/modules/campaign-cache/campaign-config-cache.service';
import type { InboundActivity } from '@/modules/idempotency/inbound-activity.types';

function buildActivity(overrides: Partial<InboundActivity> = {}): InboundActivity {
  return {
    tenantId: 1,
    customerId: 'cust-123',
    customerIdType: 'INTERNAL_ID',
    activityPerformedDate: new Date('2026-09-01T10:15:30.000Z'),
    activityCode: 'PURCHASE',
    activityType: 'TRANSACTION',
    activityCategory: 'RETAIL',
    activityValue: '100.0000',
    activityValueUnit: 'USD',
    channel: 'WEB',
    activityPerformedEnv: 'PROD',
    activityName: 'Online purchase',
    sourceTransport: 'GRPC',
    ...overrides,
  };
}

function component(overrides: Partial<MatchedTrackerComponent> = {}): MatchedTrackerComponent {
  return {
    tenantId: 1,
    campaignCode: 'CAMP1',
    campaignId: 1,
    trackerCode: 'TRK1',
    trackerId: 1,
    componentCode: 'COMP1',
    componentId: 1,
    activityId: 1,
    activityCode: 'PURCHASE',
    ...overrides,
  };
}

function fakeCache(
  overrides: Partial<CampaignConfigCacheService> = {},
): CampaignConfigCacheService {
  return {
    lookupByActivityCode: jest.fn().mockReturnValue([]),
    lookupByTransactionType: jest.fn().mockReturnValue([]),
    resolveExternalCode: jest.fn().mockReturnValue(undefined),
    getCampaignConfig: jest.fn().mockReturnValue(undefined),
    ...overrides,
  } as unknown as CampaignConfigCacheService;
}

describe('ActivityMapper.mapToComponents', () => {
  // TC-1: activityCode matching exactly one active component.
  it('returns exactly one component for a single activityCode match', () => {
    const match = component();
    const cache = fakeCache({ lookupByActivityCode: jest.fn().mockReturnValue([match]) });
    const mapper = new ActivityMapper(cache);

    const result = mapper.mapToComponents(buildActivity({ activityCode: 'PURCHASE' }));

    expect(result).toEqual([match]);
    expect(cache.lookupByActivityCode).toHaveBeenCalledWith(1, 'PURCHASE');
    expect(cache.lookupByTransactionType).not.toHaveBeenCalled();
  });

  // TC-2/TC-3: multiple matches (same campaign or different campaigns) pass through unmodified —
  // the cache itself is what decides how many components match one activityCode.
  it('returns every component the cache reports, across one or several campaigns', () => {
    const matches = [
      component({ campaignCode: 'CAMP1', componentCode: 'COMP1' }),
      component({ campaignCode: 'CAMP2', componentCode: 'COMP2' }),
    ];
    const cache = fakeCache({ lookupByActivityCode: jest.fn().mockReturnValue(matches) });
    const mapper = new ActivityMapper(cache);

    const result = mapper.mapToComponents(buildActivity({ activityCode: 'PURCHASE' }));

    expect(result).toEqual(matches);
  });

  // TC-4: transactionType only, resolvable via activity_external_code_map.
  it('resolves via lookupByTransactionType when activityCode is absent', () => {
    const match = component({ activityCode: 'PURCHASE' });
    const cache = fakeCache({ lookupByTransactionType: jest.fn().mockReturnValue([match]) });
    const mapper = new ActivityMapper(cache);

    const result = mapper.mapToComponents(
      buildActivity({ activityCode: undefined, transactionType: 'TXN_PURCHASE' }),
    );

    expect(result).toEqual([match]);
    expect(cache.lookupByTransactionType).toHaveBeenCalledWith(1, 'TXN_PURCHASE');
    expect(cache.lookupByActivityCode).not.toHaveBeenCalled();
  });

  // TC-5: activityCode matches nothing currently active (cache already filters this out) -> [].
  it('returns [] (not an error) when the cache reports no active match', () => {
    const cache = fakeCache();
    const mapper = new ActivityMapper(cache);

    const result = mapper.mapToComponents(buildActivity({ activityCode: 'INACTIVE_CODE' }));

    expect(result).toEqual([]);
  });

  it('returns [] when neither activityCode nor transactionType is present, without calling the cache', () => {
    const cache = fakeCache();
    const mapper = new ActivityMapper(cache);

    const result = mapper.mapToComponents(
      buildActivity({ activityCode: undefined, transactionType: undefined }),
    );

    expect(result).toEqual([]);
    expect(cache.lookupByActivityCode).not.toHaveBeenCalled();
    expect(cache.lookupByTransactionType).not.toHaveBeenCalled();
  });

  it('returns [] when transactionType resolves to no external-code mapping', () => {
    const cache = fakeCache({ lookupByTransactionType: jest.fn().mockReturnValue([]) });
    const mapper = new ActivityMapper(cache);

    const result = mapper.mapToComponents(
      buildActivity({ activityCode: undefined, transactionType: 'UNKNOWN_TXN' }),
    );

    expect(result).toEqual([]);
  });
});
