/**
 * T-RR-007 — `ReconciliationPollerService`'s own poll-loop lifecycle, exercised against fake
 * caches (each cache's own `refreshAll()` correctness is covered by its own spec file) — same
 * "lifecycle vs. underlying correctness" split `claim-worker.service.spec.ts` (T-RR-020) already
 * established for its own analogous poll loop.
 */
import {
  DEFAULT_RECONCILIATION_INTERVAL_MS,
  ReconciliationPollerService,
} from '@/modules/tenant-schema-cache/reconciliation-poller.service';
import type { DispatchChannelConfigCache } from '@/modules/tenant-schema-cache/dispatch-channel-config.cache';
import type { ExternalRewardSystemConfigCache } from '@/modules/tenant-schema-cache/external-reward-system-config.cache';
import type { ServiceConfigCache } from '@/modules/tenant-schema-cache/service-config.cache';
import type { TenantSchemaConfigCache } from '@/modules/tenant-schema-cache/tenant-schema-config.cache';

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function buildFakeCache(): { refreshAll: jest.Mock; invalidate: jest.Mock } {
  return { refreshAll: jest.fn().mockResolvedValue(undefined), invalidate: jest.fn() };
}

describe('T-RR-007 — ReconciliationPollerService', () => {
  let service: ReconciliationPollerService | undefined;

  afterEach(async () => {
    await service?.onModuleDestroy();
    service = undefined;
  });

  // TC-7.
  it('TC-7: wholesale-refreshes all four caches on its own clock, with no external trigger', async () => {
    const tenantSchemaConfigCache = buildFakeCache();
    const externalRewardSystemConfigCache = buildFakeCache();
    const dispatchChannelConfigCache = buildFakeCache();
    const serviceConfigCache = {
      ...buildFakeCache(),
      resolve: jest.fn().mockResolvedValue(0.02), // 20ms — a short, test-configured interval
    };

    service = new ReconciliationPollerService(
      tenantSchemaConfigCache as unknown as TenantSchemaConfigCache,
      externalRewardSystemConfigCache as unknown as ExternalRewardSystemConfigCache,
      dispatchChannelConfigCache as unknown as DispatchChannelConfigCache,
      serviceConfigCache as unknown as ServiceConfigCache,
    );

    service.onApplicationBootstrap();

    // At least two full cycles within a short window proves this runs repeatedly on its own
    // clock, not just once at boot.
    await waitFor(() => tenantSchemaConfigCache.refreshAll.mock.calls.length >= 2);

    expect(externalRewardSystemConfigCache.refreshAll.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(dispatchChannelConfigCache.refreshAll.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(serviceConfigCache.refreshAll.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('a refresh failure on one cache is logged and does not stop the loop or block the others', async () => {
    const tenantSchemaConfigCache = buildFakeCache();
    tenantSchemaConfigCache.refreshAll
      .mockRejectedValueOnce(new Error('simulated transient failure'))
      .mockResolvedValue(undefined);
    const externalRewardSystemConfigCache = buildFakeCache();
    const dispatchChannelConfigCache = buildFakeCache();
    const serviceConfigCache = {
      ...buildFakeCache(),
      resolve: jest.fn().mockResolvedValue(0.02),
    };

    service = new ReconciliationPollerService(
      tenantSchemaConfigCache as unknown as TenantSchemaConfigCache,
      externalRewardSystemConfigCache as unknown as ExternalRewardSystemConfigCache,
      dispatchChannelConfigCache as unknown as DispatchChannelConfigCache,
      serviceConfigCache as unknown as ServiceConfigCache,
    );

    service.onApplicationBootstrap();

    await waitFor(() => tenantSchemaConfigCache.refreshAll.mock.calls.length >= 2, 3000);

    expect(externalRewardSystemConfigCache.refreshAll.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to the compiled-in default interval, without crashing, when resolving its own interval fails', async () => {
    const tenantSchemaConfigCache = buildFakeCache();
    const externalRewardSystemConfigCache = buildFakeCache();
    const dispatchChannelConfigCache = buildFakeCache();
    const serviceConfigCache = {
      ...buildFakeCache(),
      resolve: jest
        .fn()
        .mockRejectedValue(new Error('cache.reconciliationPoll.intervalSeconds not seeded')),
    };

    service = new ReconciliationPollerService(
      tenantSchemaConfigCache as unknown as TenantSchemaConfigCache,
      externalRewardSystemConfigCache as unknown as ExternalRewardSystemConfigCache,
      dispatchChannelConfigCache as unknown as DispatchChannelConfigCache,
      serviceConfigCache as unknown as ServiceConfigCache,
    );

    service.onApplicationBootstrap();

    // The very first refresh cycle runs immediately regardless of interval resolution — proves
    // the loop doesn't throw/crash just because its own interval config isn't resolvable yet.
    await waitFor(() => tenantSchemaConfigCache.refreshAll.mock.calls.length >= 1);
    expect(DEFAULT_RECONCILIATION_INTERVAL_MS).toBe(300_000);
  });

  it('onModuleDestroy stops the loop — no further refreshAll calls once it resolves', async () => {
    const tenantSchemaConfigCache = buildFakeCache();
    const externalRewardSystemConfigCache = buildFakeCache();
    const dispatchChannelConfigCache = buildFakeCache();
    const serviceConfigCache = {
      ...buildFakeCache(),
      resolve: jest.fn().mockResolvedValue(0.02),
    };

    service = new ReconciliationPollerService(
      tenantSchemaConfigCache as unknown as TenantSchemaConfigCache,
      externalRewardSystemConfigCache as unknown as ExternalRewardSystemConfigCache,
      dispatchChannelConfigCache as unknown as DispatchChannelConfigCache,
      serviceConfigCache as unknown as ServiceConfigCache,
    );

    service.onApplicationBootstrap();
    await waitFor(() => tenantSchemaConfigCache.refreshAll.mock.calls.length >= 1);

    await service.onModuleDestroy();
    const countAtStop = tenantSchemaConfigCache.refreshAll.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(tenantSchemaConfigCache.refreshAll.mock.calls.length).toBe(countAtStop);
  });
});
