/**
 * T-RR-007 — `CacheInvalidationService`, unit-tested against fake caches + a fake audit
 * repository. The guard's own `401` behaviour (TC-5) is covered by `cache-admin-auth.guard`'s
 * exercise inside `cache-invalidation.controller.spec.ts` — this file covers the service's own
 * request-shape validation and cache/audit wiring (TC-3, TC-4, TC-6, TC-8, and the negative shapes
 * a `400` should cover).
 *
 * **T-RR-054**: `campaignConfig` (`CampaignConfigCache`) is now a real, active fifth cache in the
 * registry — TC-6 below no longer asserts the old "not yet active" stub response (that behaviour
 * is gone; see `cache-invalidation.service.ts`'s own header), and a new pair of tests cover its two
 * real request shapes: a bare `{"key": "campaignConfig"}` (whole-cache clear, same as any other
 * cache) and the scoped `{"key": "campaignConfig", "campaignCode": ..., "tenantId": ...}` shape
 * (`06-CACHING-AND-TENANT-CONFIG.md` §3's own narrow-clear note), which must call
 * `CampaignConfigCache.invalidateOne` instead of its generic `invalidate()`.
 *
 * **T-RR-060**: `cache_invalidation_total{key}` (`07-CONFIGURABILITY-AND-OBSERVABILITY.md` §3) is
 * now asserted directly against a real `MetricsRegistry` instance (not a mock counting calls to a
 * fake) — the whole point of the defect this fixes is that the *observable metric value* is what
 * matters, not merely that some method got called. See "T-RR-060" tests below.
 */
import { BadRequestException } from '@nestjs/common';
import { CacheInvalidationService } from '@/modules/cache-invalidation/cache-invalidation.service';
import type { CacheInvalidationAuditRepository } from '@/modules/cache-invalidation/cache-invalidation-audit.repository';
import type { CampaignConfigCache } from '@/modules/processing/campaign-config.cache';
import type { DispatchChannelConfigCache } from '@/modules/tenant-schema-cache/dispatch-channel-config.cache';
import type { ExternalRewardSystemConfigCache } from '@/modules/tenant-schema-cache/external-reward-system-config.cache';
import type { ServiceConfigCache } from '@/modules/tenant-schema-cache/service-config.cache';
import type { TenantSchemaConfigCache } from '@/modules/tenant-schema-cache/tenant-schema-config.cache';
import { MetricsRegistry } from '@/observability/metrics.registry';

const INVOKED_BY = 'cache-admin-token';

function buildFakeCache(): { invalidate: jest.Mock; refreshAll: jest.Mock } {
  return { invalidate: jest.fn(), refreshAll: jest.fn().mockResolvedValue(undefined) };
}

function buildFakeCampaignConfigCache(): {
  invalidate: jest.Mock;
  refreshAll: jest.Mock;
  invalidateOne: jest.Mock;
} {
  return { ...buildFakeCache(), invalidateOne: jest.fn() };
}

function build(): {
  service: CacheInvalidationService;
  tenantSchemaConfigCache: ReturnType<typeof buildFakeCache>;
  externalRewardSystemConfigCache: ReturnType<typeof buildFakeCache>;
  dispatchChannelConfigCache: ReturnType<typeof buildFakeCache>;
  serviceConfigCache: ReturnType<typeof buildFakeCache>;
  campaignConfigCache: ReturnType<typeof buildFakeCampaignConfigCache>;
  record: jest.Mock;
  metrics: MetricsRegistry;
} {
  const tenantSchemaConfigCache = buildFakeCache();
  const externalRewardSystemConfigCache = buildFakeCache();
  const dispatchChannelConfigCache = buildFakeCache();
  const serviceConfigCache = buildFakeCache();
  const campaignConfigCache = buildFakeCampaignConfigCache();
  const record = jest.fn().mockResolvedValue({});
  const auditRepository = { record } as unknown as CacheInvalidationAuditRepository;
  // A real `MetricsRegistry` instance, not a mock — T-RR-060's regression coverage asserts the
  // actual counter value `getCounterValue()` reports, which a call-counting mock cannot catch a
  // wrong label (or a missing call) on with the same fidelity.
  const metrics = new MetricsRegistry();

  const service = new CacheInvalidationService(
    tenantSchemaConfigCache as unknown as TenantSchemaConfigCache,
    externalRewardSystemConfigCache as unknown as ExternalRewardSystemConfigCache,
    dispatchChannelConfigCache as unknown as DispatchChannelConfigCache,
    serviceConfigCache as unknown as ServiceConfigCache,
    campaignConfigCache as unknown as CampaignConfigCache,
    auditRepository,
    metrics,
  );

  return {
    service,
    tenantSchemaConfigCache,
    externalRewardSystemConfigCache,
    dispatchChannelConfigCache,
    serviceConfigCache,
    campaignConfigCache,
    record,
    metrics,
  };
}

describe('T-RR-007 — CacheInvalidationService', () => {
  // TC-3.
  it('TC-3: {"key": "dispatchChannelConfig"} clears only that cache and audits it by name', async () => {
    const { service, dispatchChannelConfigCache, tenantSchemaConfigCache, record } = build();

    const response = await service.invalidate({ key: 'dispatchChannelConfig' }, INVOKED_BY);

    expect(response.invalidated).toEqual(['dispatchChannelConfig']);
    expect(dispatchChannelConfigCache.invalidate).toHaveBeenCalledTimes(1);
    expect(tenantSchemaConfigCache.invalidate).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith('dispatchChannelConfig', INVOKED_BY);
  });

  // TC-4.
  it('TC-4: {"all": true} clears every registered cache (all five) and audits with cache_key = null', async () => {
    const {
      service,
      tenantSchemaConfigCache,
      externalRewardSystemConfigCache,
      dispatchChannelConfigCache,
      serviceConfigCache,
      campaignConfigCache,
      record,
    } = build();

    const response = await service.invalidate({ all: true }, INVOKED_BY);

    expect(response.invalidated.sort()).toEqual(
      [
        'tenantSchemaConfig',
        'externalRewardSystemConfig',
        'dispatchChannelConfig',
        'serviceConfig',
        'campaignConfig',
      ].sort(),
    );
    expect(tenantSchemaConfigCache.invalidate).toHaveBeenCalledTimes(1);
    expect(externalRewardSystemConfigCache.invalidate).toHaveBeenCalledTimes(1);
    expect(dispatchChannelConfigCache.invalidate).toHaveBeenCalledTimes(1);
    expect(serviceConfigCache.invalidate).toHaveBeenCalledTimes(1);
    // The whole-cache sweep always calls the generic `invalidate()`, never `invalidateOne` —
    // there is no per-entry scoping in an `{"all": true}` request.
    expect(campaignConfigCache.invalidate).toHaveBeenCalledTimes(1);
    expect(campaignConfigCache.invalidateOne).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(null, INVOKED_BY);
    expect(record).toHaveBeenCalledTimes(1);
  });

  // TC-6.
  it('TC-6: a bare {"key": "campaignConfig"} clears the whole campaign cache like any other cache', async () => {
    const { service, campaignConfigCache, record } = build();

    const response = await service.invalidate({ key: 'campaignConfig' }, INVOKED_BY);

    expect(response.invalidated).toEqual(['campaignConfig']);
    expect(campaignConfigCache.invalidate).toHaveBeenCalledTimes(1);
    expect(campaignConfigCache.invalidateOne).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith('campaignConfig', INVOKED_BY);
  });

  // TC-2/TC-4 of T-RR-054 — 06-CACHING-AND-TENANT-CONFIG.md §3's own scoped-clear shape.
  it('a {"key": "campaignConfig", "campaignCode", "tenantId"} request narrow-clears via invalidateOne, not the whole cache', async () => {
    const { service, campaignConfigCache, record } = build();

    const response = await service.invalidate(
      { key: 'campaignConfig', campaignCode: 'SUMMER25', tenantId: 7 },
      INVOKED_BY,
    );

    expect(response.invalidated).toEqual(['campaignConfig']);
    expect(campaignConfigCache.invalidateOne).toHaveBeenCalledWith(7, 'SUMMER25');
    expect(campaignConfigCache.invalidateOne).toHaveBeenCalledTimes(1);
    expect(campaignConfigCache.invalidate).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith('campaignConfig', INVOKED_BY);
  });

  it('a campaignConfig request with only one of campaignCode/tenantId falls back to a whole-cache clear', async () => {
    const { service, campaignConfigCache } = build();

    await service.invalidate({ key: 'campaignConfig', campaignCode: 'SUMMER25' }, INVOKED_BY);

    expect(campaignConfigCache.invalidate).toHaveBeenCalledTimes(1);
    expect(campaignConfigCache.invalidateOne).not.toHaveBeenCalled();
  });

  it('campaignCode/tenantId scoping fields on a non-campaignConfig key are ignored — whole-cache clear as usual', async () => {
    const { service, dispatchChannelConfigCache } = build();

    await service.invalidate(
      { key: 'dispatchChannelConfig', campaignCode: 'SUMMER25', tenantId: 7 },
      INVOKED_BY,
    );

    expect(dispatchChannelConfigCache.invalidate).toHaveBeenCalledTimes(1);
  });

  it('rejects a genuinely unknown cache key with a 400, without touching any cache or the audit log', async () => {
    const { service, record, tenantSchemaConfigCache } = build();

    await expect(service.invalidate({ key: 'notARealCache' }, INVOKED_BY)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tenantSchemaConfigCache.invalidate).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('rejects a request with neither "key" nor "all": true', async () => {
    const { service, record } = build();

    await expect(service.invalidate({}, INVOKED_BY)).rejects.toBeInstanceOf(BadRequestException);
    expect(record).not.toHaveBeenCalled();
  });

  it('rejects a request supplying both "key" and "all": true as ambiguous', async () => {
    const { service, record } = build();

    await expect(
      service.invalidate({ key: 'serviceConfig', all: true }, INVOKED_BY),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(record).not.toHaveBeenCalled();
  });

  // TC-8.
  it('TC-8: two concurrent invalidations of the same key both succeed and write two audit rows', async () => {
    const { service, dispatchChannelConfigCache, record } = build();

    const [first, second] = await Promise.all([
      service.invalidate({ key: 'dispatchChannelConfig' }, INVOKED_BY),
      service.invalidate({ key: 'dispatchChannelConfig' }, INVOKED_BY),
    ]);

    expect(first.invalidated).toEqual(['dispatchChannelConfig']);
    expect(second.invalidated).toEqual(['dispatchChannelConfig']);
    expect(dispatchChannelConfigCache.invalidate).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(2);
  });

  // T-RR-060 — cache_invalidation_total{key} regression coverage. Proven to fail (both increment
  // call sites deleted, i.e. the reported defect) before the fix landed.
  describe('T-RR-060: cache_invalidation_total{key}', () => {
    it('increments cache_invalidation_total{key="dispatchChannelConfig"} on a real, processed single-key request', async () => {
      const { service, metrics } = build();

      await service.invalidate({ key: 'dispatchChannelConfig' }, INVOKED_BY);

      expect(
        metrics.getCounterValue('cache_invalidation_total', { key: 'dispatchChannelConfig' }),
      ).toBe(1);
      // No other cache-key series was ever touched by this one request.
      expect(metrics.getCounterValue('cache_invalidation_total', { key: 'all' })).toBe(0);
      expect(metrics.getCounterValue('cache_invalidation_total', { key: 'serviceConfig' })).toBe(0);
    });

    it('increments cache_invalidation_total{key="all"} — not once per cache — on a whole-registry clear', async () => {
      const { service, metrics } = build();

      await service.invalidate({ all: true }, INVOKED_BY);

      expect(metrics.getCounterValue('cache_invalidation_total', { key: 'all' })).toBe(1);
      // §3's own literal label is 'all', never one of the five real cache names, for this shape.
      expect(
        metrics.getCounterValue('cache_invalidation_total', { key: 'tenantSchemaConfig' }),
      ).toBe(0);
    });

    it('increments cache_invalidation_total{key="campaignConfig"} for a scoped campaignConfig clear, same as a whole-cache one', async () => {
      const { service, metrics } = build();

      await service.invalidate(
        { key: 'campaignConfig', campaignCode: 'SUMMER25', tenantId: 7 },
        INVOKED_BY,
      );

      expect(metrics.getCounterValue('cache_invalidation_total', { key: 'campaignConfig' })).toBe(
        1,
      );
    });

    it('accumulates across repeated calls to the same key rather than resetting', async () => {
      const { service, metrics } = build();

      await service.invalidate({ key: 'serviceConfig' }, INVOKED_BY);
      await service.invalidate({ key: 'serviceConfig' }, INVOKED_BY);
      await service.invalidate({ key: 'serviceConfig' }, INVOKED_BY);

      expect(metrics.getCounterValue('cache_invalidation_total', { key: 'serviceConfig' })).toBe(3);
    });

    it('does NOT increment the metric when a request is rejected before reaching a terminal branch', async () => {
      const { service, metrics } = build();

      await expect(service.invalidate({ key: 'notARealCache' }, INVOKED_BY)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.invalidate({}, INVOKED_BY)).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.invalidate({ key: 'serviceConfig', all: true }, INVOKED_BY),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(metrics.getCounterValue('cache_invalidation_total', { key: 'notARealCache' })).toBe(0);
      expect(metrics.getCounterValue('cache_invalidation_total', { key: 'all' })).toBe(0);
      expect(metrics.getCounterValue('cache_invalidation_total', { key: 'serviceConfig' })).toBe(0);
    });
  });
});
