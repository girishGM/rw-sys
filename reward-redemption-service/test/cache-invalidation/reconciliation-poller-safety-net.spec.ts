/**
 * T-RR-044 — the reconciliation-poller safety net (`06-CACHING-AND-TENANT-CONFIG.md` §4,
 * implementation note 4) and the invalidation endpoint's own "lazy re-fill, never eager"
 * contract (§3, implementation note 5), tested as two deliberately separate paths per this task's
 * own instruction (never conflate a TTL-expiry/poller-driven refresh with an invalidation-endpoint
 * re-fill).
 *
 * TC-8 is proven against a REAL `DispatchChannelConfigRepository`/real local Postgres — every
 * existing `ReconciliationPollerService`/`DispatchChannelConfigCache` unit spec (T-RR-007,
 * `test/tenant-schema-cache/*.spec.ts`) exercises the loop's own lifecycle and each cache's own
 * `refreshAll()` shape against *fakes*; this file's own addition is the one path neither already
 * covers — a genuine, un-invalidated DB row mutation reaching a real cache purely because the
 * poller's own clock fired, independent of the app's real DB-mutation-detection story. The
 * `serviceConfigCache` dependency both the cache and the poller need is faked here (never the real
 * seeded `service_config` GLOBAL rows) specifically to avoid mutating a table every other
 * concurrently-running real-Postgres spec file also reads (the exact class of cross-file race
 * `T-RR-052`/`T-RR-053` already document for this codebase) — the interval/TTL values under test
 * are this file's own local concern, not global service configuration.
 */
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import type { Config } from '@/config/config.schema';
import { AppModule } from '@/app.module';
import { createMigrationConnection } from '@/database/migration-connection';
import {
  DispatchChannelConfigCache,
  type DispatchChannelConfigKey,
} from '@/modules/tenant-schema-cache/dispatch-channel-config.cache';
import { DispatchChannelConfigRepository } from '@/modules/tenant-schema-cache/dispatch-channel-config.repository';
import { ReconciliationPollerService } from '@/modules/tenant-schema-cache/reconciliation-poller.service';
import type { ServiceConfigCache } from '@/modules/tenant-schema-cache/service-config.cache';
import type { ExternalRewardSystemConfigCache } from '@/modules/tenant-schema-cache/external-reward-system-config.cache';
import type { TenantSchemaConfigCache } from '@/modules/tenant-schema-cache/tenant-schema-config.cache';

function realDbConfigService(): ConfigService<Config, true> {
  const values: Partial<Config> = {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: Number(process.env.DB_PORT),
    DB_NAME: process.env.DB_NAME,
    DB_SSL: process.env.DB_SSL === 'true',
    DB_APP_USERNAME: process.env.DB_APP_USERNAME,
    DB_APP_PASSWORD: process.env.DB_APP_PASSWORD,
  } as Partial<Config>;
  return {
    get: ((key: keyof Config) => values[key]) as ConfigService<Config, true>['get'],
  } as ConfigService<Config, true>;
}

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

describe('T-RR-044 — TC-8: reconciliation-poller safety net (real DB, no invalidation call)', () => {
  let migrationDb: Sequelize;
  let repository: DispatchChannelConfigRepository;
  let poller: ReconciliationPollerService;
  const scopeRefCode = `T-RR-044-poller-${randomUUID()}`;
  const key: DispatchChannelConfigKey = {
    scopeLevel: 'CAMPAIGN',
    scopeRefCode,
    tenantId: null,
  };

  beforeAll(async () => {
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
  });

  afterEach(async () => {
    await poller?.onModuleDestroy();
    await repository?.onModuleDestroy();
  });

  it('a direct DB mutation with no invalidation call is still eventually reflected once the poller fires its own next cycle', async () => {
    repository = new DispatchChannelConfigRepository(realDbConfigService());
    const findAllSpy = jest.spyOn(repository, 'findAll');
    const findByScopeSpy = jest.spyOn(repository, 'findByScope');

    // A fake `ServiceConfigCache`: a huge TTL for `dispatchChannelConfig` (so TTL expiry can never
    // explain an observed refresh) and a short poll interval (so this test doesn't need to wait
    // anywhere near the real 300s default) — see this file's own header for why this is faked
    // rather than mutating the real, shared `service_config` GLOBAL rows.
    const fakeServiceConfigCache = {
      ...buildNoopRefreshCache(),
      resolve: jest.fn().mockImplementation((configKey: string) => {
        if (configKey === 'cache.reconciliationPoll.intervalSeconds') {
          return Promise.resolve(0.05); // 50ms
        }
        return Promise.resolve(999_999); // effectively "never expires" for every TTL key
      }),
    };
    const dispatchCache = new DispatchChannelConfigCache(
      repository,
      fakeServiceConfigCache as unknown as ServiceConfigCache,
    );
    const fakeTenantSchemaConfigCache = buildNoopRefreshCache();
    const fakeExternalRewardSystemConfigCache = buildNoopRefreshCache();

    poller = new ReconciliationPollerService(
      fakeTenantSchemaConfigCache as unknown as TenantSchemaConfigCache,
      fakeExternalRewardSystemConfigCache as unknown as ExternalRewardSystemConfigCache,
      dispatchCache,
      fakeServiceConfigCache as unknown as ServiceConfigCache,
    );

    poller.onApplicationBootstrap();
    // `mock.calls.length` increments the instant `findAll()` is *invoked*, not once its promise
    // has settled — waiting for a SECOND call is what actually guarantees the first cycle's
    // `Promise.all(...)` fully resolved (the loop's own `await refreshOnce()` cannot invoke a next
    // cycle until the current one settles), so the cache is genuinely populated by the time this
    // proceeds, not merely "a fetch was kicked off".
    await waitFor(() => findAllSpy.mock.calls.length >= 2);

    const initial = await dispatchCache.get(key);
    expect(initial?.primary_channel).toBe('KAFKA');

    const cyclesBeforeMutation = findAllSpy.mock.calls.length;

    // The missed/failed invalidation this section simulates: a direct row edit, no call to
    // POST /api/v1/cache/invalidate at all.
    await migrationDb.query(
      `UPDATE reward_redemption.dispatch_channel_config SET primary_channel = 'REST'
       WHERE scope_ref_code = :scopeRefCode`,
      { type: QueryTypes.UPDATE, replacements: { scopeRefCode } },
    );

    // Wait for one more full cycle (same "second call proves the first settled" reasoning above)
    // to run past the mutation.
    await waitFor(() => findAllSpy.mock.calls.length >= cyclesBeforeMutation + 2);

    const afterPoll = await dispatchCache.get(key);
    expect(afterPoll?.primary_channel).toBe('REST');
    // The updated value came from the poller's own wholesale `findAll()` refresh, never from a
    // targeted `findByScope()` re-fetch triggered by this test's own `get()` calls — proves it was
    // genuinely the poller's own clock, not a coincidental cache-miss re-fetch on read.
    expect(findByScopeSpy).not.toHaveBeenCalled();
  });
});

describe('T-RR-044 — TC-9: invalidation clears lazily, never eagerly re-fetches', () => {
  let app: INestApplication;
  let db: Sequelize;

  beforeAll(async () => {
    db = createMigrationConnection();
    await db.authenticate();
    // `ReconciliationPollerService` is overridden to a no-op here deliberately — its own real
    // `onApplicationBootstrap()` fires a background `pollLoop()` it does NOT await (fire-and-forget
    // by design, `reconciliation-poller.service.ts`'s own shape), so `app.init()` can resolve while
    // that first cycle's real DB round trip is still in flight. Left wired in, its completion can
    // land at any point relative to this test's own calls and silently repopulate the exact cache
    // entry this test inspects via its own wholesale `findAll()` refresh (not `findByScope()`),
    // confirmed by direct reproduction (temporary debug logging showed a genuine "second read
    // returns fresh data via zero findByScope calls" outcome on a failing run) — a real
    // interaction with §4's safety net, not a flaw in the property TC-9 itself asserts. §4's own
    // mechanics are exhaustively covered on their own terms by the "TC-8" describe block above
    // (direct construction, no Nest DI, a controlled fake interval) — this describe block isolates
    // §3's "lazy re-fill, never eager" contract from that separate mechanism instead of conflating
    // the two, per this task's own implementation note 5.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ReconciliationPollerService)
      .useValue({ onApplicationBootstrap: () => undefined, onModuleDestroy: async () => undefined })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await db.close();
    await app.close();
    // See `admin-auth.spec.ts`'s own identical comment: a generous explicit hook timeout for real
    // teardown under real heavy concurrent DB load, not a leak.
  }, 15_000);

  it('TC-9: no repository re-fetch happens at the moment of invalidation itself — only the next read that misses re-fills', async () => {
    const dispatchRepository = app.get(DispatchChannelConfigRepository);
    const dispatchCache = app.get(DispatchChannelConfigCache);
    const findByScopeSpy = jest.spyOn(dispatchRepository, 'findByScope');

    // Prime the cache first.
    await dispatchCache.get({ scopeLevel: 'GLOBAL', scopeRefCode: null, tenantId: null });
    findByScopeSpy.mockClear();

    const response = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', `Bearer ${process.env.CACHE_ADMIN_TOKEN}`)
      .send({ key: 'dispatchChannelConfig' });
    expect(response.status).toBe(200);

    // No eager re-fetch triggered by the invalidation call itself.
    expect(findByScopeSpy).not.toHaveBeenCalled();

    // The very next read that misses is what re-fills — exactly once.
    await dispatchCache.get({ scopeLevel: 'GLOBAL', scopeRefCode: null, tenantId: null });
    expect(findByScopeSpy).toHaveBeenCalledTimes(1);

    findByScopeSpy.mockRestore();
  });
});
