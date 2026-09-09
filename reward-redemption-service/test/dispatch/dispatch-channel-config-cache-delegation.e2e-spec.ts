/**
 * T-RR-069 — regression coverage for the defect this task fixes: `DispatchChannelResolverService`
 * (T-RR-033, the service that makes every real Kafka-vs-REST routing decision) read from its own,
 * completely independent `DispatchChannelConfigCache` (`./dispatch-channel-config.cache.ts`),
 * while `POST /api/v1/cache/invalidate` and `ReconciliationPollerService` (T-RR-007) only ever
 * touched a *second*, separate `DispatchChannelConfigCache` instance
 * (`@/modules/tenant-schema-cache/dispatch-channel-config.cache.ts`) that nothing in the real
 * routing path ever read. Calling the documented invalidation endpoint for this key was therefore a
 * functional no-op against real behaviour — a 200 response and an audit row, with the real cache
 * unaffected. See `../../src/modules/dispatch/dispatch-channel-config.cache.ts`'s own header for
 * the full defect writeup and the fix this file proves.
 *
 * **Why this compiles `DispatchModule` directly (not the full `AppModule`)**: `DispatchModule`
 * itself is the one this task owns and the one whose provider wiring is actually under test — the
 * real production path this reaches (`RedemptionStateMachineModule` → `DispatchModule`, reachable
 * from the standalone claim-worker process; see this task's own evidence write-up) never boots the
 * full HTTP `AppModule` either. `TC-1`/`TC-2` below don't call `CacheInvalidationService` through
 * its own HTTP controller (owned by `agent-rr-foundation`, out of this task's file scope) — instead
 * they call `.invalidate()` directly on the exact same shared cache instance that service's own
 * `invalidateOne('dispatchChannelConfig', ...)` calls it on (`cache-invalidation.service.ts`'s own
 * `registry.get('dispatchChannelConfig').invalidate()`), which is the one piece of real behaviour
 * this defect is about — whether that call reaches the cache `DispatchChannelResolverService`
 * actually reads, not the HTTP/guard/audit-log plumbing around it (already covered elsewhere, by
 * that module's own owning agent).
 *
 * Real Postgres throughout (root `CLAUDE.md`) — a fake repository can't prove two DI-wired classes
 * share one real row's freshness.
 */
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { createMigrationConnection } from '@/database/migration-connection';
import { DispatchModule } from '@/modules/dispatch/dispatch.module';
import { DispatchChannelResolverService } from '@/modules/dispatch/dispatch-channel-resolver.service';
import { DispatchChannelConfigCache as SharedDispatchChannelConfigCache } from '@/modules/tenant-schema-cache/dispatch-channel-config.cache';
import { ReconciliationPollerService } from '@/modules/tenant-schema-cache/reconciliation-poller.service';
import type { ServiceConfigCache } from '@/modules/tenant-schema-cache/service-config.cache';
import type { TenantSchemaConfigCache } from '@/modules/tenant-schema-cache/tenant-schema-config.cache';
import type { ExternalRewardSystemConfigCache } from '@/modules/tenant-schema-cache/external-reward-system-config.cache';
import { ConfigModule } from '@/config/config.module';

/** A no-op `InvalidatableCache`-shaped fake for the three caches `ReconciliationPollerService`
 * needs but this suite doesn't exercise — same idiom
 * `test/cache-invalidation/reconciliation-poller-safety-net.spec.ts` (T-RR-044) already
 * established for the identical constructor shape. */
function buildNoopRefreshCache(): { refreshAll: jest.Mock; invalidate: jest.Mock } {
  return { refreshAll: jest.fn().mockResolvedValue(undefined), invalidate: jest.fn() };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    // eslint-disable-next-line no-await-in-loop -- a short deterministic poll loop, test-only.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// REWARD_TRACKING_REST_TOKEN is required for `DispatchModule` to compile via real Nest DI — same
// requirement `dispatch-module-di.e2e-spec.ts` (T-RR-064) already documents and satisfies the same
// way (never a real secret, never a file this task doesn't own).
const ORIGINAL_TOKEN = process.env.REWARD_TRACKING_REST_TOKEN;

describe('T-RR-069 — DispatchChannelResolverService and the invalidation-endpoint-connected cache are the same cache', () => {
  let migrationDb: Sequelize;
  const scopeRefCode = `T-RR-069-${randomUUID()}`;

  beforeAll(async () => {
    process.env.REWARD_TRACKING_REST_TOKEN = 'test-only-reward-tracking-token';
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
    await migrationDb.query(
      `INSERT INTO reward_redemption.dispatch_channel_config
         (scope_level, scope_ref_code, tenant_id, kafka_enabled, rest_enabled, primary_channel, fallback_channel)
       VALUES ('CAMPAIGN', :scopeRefCode, NULL, true, true, 'KAFKA', 'REST')`,
      { type: QueryTypes.INSERT, replacements: { scopeRefCode } },
    );
  });

  afterAll(async () => {
    await migrationDb.query(
      'DELETE FROM reward_redemption.dispatch_channel_config WHERE scope_ref_code = :scopeRefCode',
      { type: QueryTypes.DELETE, replacements: { scopeRefCode } },
    );
    await migrationDb.close();
    process.env.REWARD_TRACKING_REST_TOKEN = ORIGINAL_TOKEN;
  });

  // TC-1 (reproduce)/TC-2 (same check after fix) are recorded in this task's own completion
  // report as a manual before/after diagnosis (temporarily reverting this task's own fix and
  // re-running this exact suite) — see that report for the pasted output. TC-3 below is the
  // permanent, always-run regression proof.
  it('TC-3: invalidating the real, shared cache (the exact call the invalidation endpoint makes) is observed by the real resolver — reproduces red on the unfixed code', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DispatchModule],
    }).compile();

    try {
      const resolver = moduleRef.get(DispatchChannelResolverService);
      // The exact singleton `CacheInvalidationService`'s own registry holds under the
      // `'dispatchChannelConfig'` key (`cache-invalidation.service.ts`) — obtained here via
      // `TenantSchemaCacheModule`, which `DispatchModule` now imports for exactly this purpose.
      const sharedCache = moduleRef.get(SharedDispatchChannelConfigCache);

      const before = await resolver.resolve({ campaignCode: scopeRefCode });
      expect(before.primaryChannel).toBe('KAFKA');

      await migrationDb.query(
        `UPDATE reward_redemption.dispatch_channel_config
           SET primary_channel = 'REST', fallback_channel = 'KAFKA'
         WHERE scope_ref_code = :scopeRefCode`,
        { type: QueryTypes.UPDATE, replacements: { scopeRefCode } },
      );

      // Still cached — the DB mutation above alone must not be visible yet (TTL is a real 300s,
      // seeded by `015_seed_service_config_defaults.ts`). This is what makes the next assertion a
      // genuine proof of invalidation reaching the real cache, not just TTL happening to expire.
      const stillCached = await resolver.resolve({ campaignCode: scopeRefCode });
      expect(stillCached.primaryChannel).toBe('KAFKA');

      // The one call this whole defect is about: on the unfixed code, `sharedCache` here is a
      // *different* instance from the one `resolver` actually reads (`DispatchModule`'s own,
      // separate `DispatchChannelConfigCache`), so this call would clear nothing the resolver ever
      // consults, and the assertion below would fail (still `KAFKA`, not `REST`).
      sharedCache.invalidate();

      const afterInvalidate = await resolver.resolve({ campaignCode: scopeRefCode });
      expect(afterInvalidate.primaryChannel).toBe('REST');
    } finally {
      await moduleRef.close();
    }
  });

  it("TC-4 (adjacent behaviour): the reconciliation poller's own refresh of the real, shared cache is also observed by the real resolver, with no explicit invalidate() call", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DispatchModule],
    }).compile();
    let poller: ReconciliationPollerService | undefined;

    try {
      const resolver = moduleRef.get(DispatchChannelResolverService);
      const sharedCache = moduleRef.get(SharedDispatchChannelConfigCache);

      const before = await resolver.resolve({ campaignCode: scopeRefCode });
      // Whatever TC-3 above left this row as — this test only cares about the *next* transition,
      // so it re-derives its own starting value rather than assuming ordering between `it` blocks.
      const startingChannel = before.primaryChannel;
      const flippedChannel = startingChannel === 'KAFKA' ? 'REST' : 'KAFKA';

      await migrationDb.query(
        `UPDATE reward_redemption.dispatch_channel_config
           SET primary_channel = :flippedChannel
         WHERE scope_ref_code = :scopeRefCode`,
        { type: QueryTypes.UPDATE, replacements: { scopeRefCode, flippedChannel } },
      );

      // A fast fake poll interval (same idiom `reconciliation-poller-safety-net.spec.ts`,
      // T-RR-044, already established) — this suite has no reason to wait anywhere near the real
      // 300s default, and faking it (rather than mutating the real, shared `service_config` table)
      // avoids the exact cross-file race `T-RR-052`/`T-RR-053` already document for this codebase.
      const fakeServiceConfigCache = {
        ...buildNoopRefreshCache(),
        resolve: jest.fn().mockResolvedValue(0.05), // 50ms
      };
      poller = new ReconciliationPollerService(
        buildNoopRefreshCache() as unknown as TenantSchemaConfigCache,
        buildNoopRefreshCache() as unknown as ExternalRewardSystemConfigCache,
        sharedCache,
        fakeServiceConfigCache as unknown as ServiceConfigCache,
      );
      const refreshSpy = jest.spyOn(sharedCache, 'refreshAll');

      poller.onApplicationBootstrap();
      await waitFor(() => refreshSpy.mock.calls.length >= 2);

      const afterPoll = await resolver.resolve({ campaignCode: scopeRefCode });
      expect(afterPoll.primaryChannel).toBe(flippedChannel);
    } finally {
      await poller?.onModuleDestroy();
      await moduleRef.close();
    }
  });
});
