/**
 * T-RR-044 — `cache_invalidation_audit` row-shape correctness for both `POST
 * /api/v1/cache/invalidate` request shapes (`01-DATABASE.md` §11, `06-CACHING-AND-TENANT-CONFIG.md`
 * §3, implementation note 2), plus the "only the target cache is touched" and "unknown key is a
 * defined error, never a silent no-op" properties (implementation notes 3/5, TC-10).
 *
 * Against the real, fully-wired `AppModule` and the real local Postgres server — the same
 * "curl-able real instance" shape `test/cache-invalidation/cache-invalidation.controller.spec.ts`
 * (T-RR-007) already establishes for this endpoint.
 *
 * **Row-shape assertions read the row from `CacheInvalidationAuditRepository.record`'s own resolved
 * return value (spied on this app instance's real, singleton repository, real DB write still
 * happening underneath) — never a `SELECT ... ORDER BY invoked_at DESC LIMIT 1` query.** That query
 * shape is racy against every *other* concurrently-running real-Postgres spec file under
 * `test/cache-invalidation/**` (each its own `AppModule` instance, all writing the same physical
 * table) — a different file's own request can land as the "most recent" row in the exact window
 * between this file's own POST and its own SELECT (reproduced directly: a pre-existing T-RR-007
 * test using this identical query shape failed for exactly this reason during this task's own
 * verification). `record`'s own return value is the exact row *this* call's own `INSERT ...
 * RETURNING *` produced — correct by construction, immune to what any other process is doing to
 * the same table at the same time. The same reasoning applies to "no audit row written"/"exactly
 * one more row" checks, via the spy's own call history rather than a table-wide count.
 *
 * TC-3, TC-5, TC-6, TC-10 (`tasks/T-RR-044-cache-invalidation-hardening.md`).
 */
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { CacheInvalidationAuditRepository } from '@/modules/cache-invalidation/cache-invalidation-audit.repository';
import { DispatchChannelConfigCache } from '@/modules/tenant-schema-cache/dispatch-channel-config.cache';
import { DispatchChannelConfigRepository } from '@/modules/tenant-schema-cache/dispatch-channel-config.repository';

const ADMIN_HEADER = () => `Bearer ${process.env.CACHE_ADMIN_TOKEN}`;

describe('T-RR-044 — cache_invalidation_audit correctness', () => {
  let app: INestApplication;
  let recordSpy: jest.SpyInstance;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    recordSpy = jest.spyOn(app.get(CacheInvalidationAuditRepository), 'record');
  });

  afterAll(async () => {
    await app.close();
    // See `admin-auth.spec.ts`'s own identical comment: `app.close()` occasionally exceeds Jest's
    // default 5000ms hook timeout tearing down every real pool/poller this app graph opened, under
    // real heavy concurrent load — a generous explicit timeout, not a leak.
  }, 15_000);

  beforeEach(() => {
    recordSpy.mockClear();
  });

  // TC-5.
  it('TC-5: a keyed invalidation writes cache_key = the exact key name, invoked_by = the authenticated identity, invoked_at present', async () => {
    const before = Date.now();

    const response = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', ADMIN_HEADER())
      .send({ key: 'externalRewardSystemConfig' });

    expect(response.status).toBe(200);
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith('externalRewardSystemConfig', 'cache-admin-token');
    const row = await recordSpy.mock.results[0].value;
    expect(row.cache_key).toBe('externalRewardSystemConfig');
    expect(row.invoked_by).toBe('cache-admin-token');
    expect(row.invoked_at).toBeTruthy();
    expect(new Date(row.invoked_at).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  // TC-6.
  it('TC-6: an {"all": true} invalidation writes cache_key = NULL', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', ADMIN_HEADER())
      .send({ all: true });

    expect(response.status).toBe(200);
    expect(recordSpy).toHaveBeenCalledWith(null, 'cache-admin-token');
    const row = await recordSpy.mock.results[0].value;
    expect(row.cache_key).toBeNull();
    expect(row.invoked_by).toBe('cache-admin-token');
  });

  // Implementation note 2's own "regardless of whether the target cache actually had anything
  // cached at the time" requirement.
  it('an invalidation is audited even when the target cache is already cold (an already-cleared cache is still a real, auditable event)', async () => {
    // First call clears it (cache is now cold, whatever it held before).
    const first = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', ADMIN_HEADER())
      .send({ key: 'dispatchChannelConfig' });
    expect(first.status).toBe(200);
    recordSpy.mockClear();

    // Second call targets the same, now-cold cache — still a real invalidation event.
    const second = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', ADMIN_HEADER())
      .send({ key: 'dispatchChannelConfig' });

    expect(second.status).toBe(200);
    expect(recordSpy).toHaveBeenCalledTimes(1);
    const row = await recordSpy.mock.results[0].value;
    expect(row.cache_key).toBe('dispatchChannelConfig');
  });

  // TC-3's own "others untouched" half — proven observably: a different cache's own already-cached
  // entry survives a keyed invalidation of some other cache, evidenced by no re-fetch on its own
  // next read (protocol's "assert the observable property" discipline, not an implementation
  // string).
  it('TC-3: a keyed invalidation of one cache never touches a different cache', async () => {
    const dispatchRepository = app.get(DispatchChannelConfigRepository);
    const dispatchCache = app.get(DispatchChannelConfigCache);
    const findByScopeSpy = jest.spyOn(dispatchRepository, 'findByScope');

    // Prime dispatchChannelConfig's own cache with the seeded GLOBAL row.
    await dispatchCache.get({ scopeLevel: 'GLOBAL', scopeRefCode: null, tenantId: null });
    findByScopeSpy.mockClear();

    const response = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', ADMIN_HEADER())
      .send({ key: 'serviceConfig' });
    expect(response.status).toBe(200);

    // dispatchChannelConfig's own cache was never asked to invalidate — its entry is still there,
    // so this read is a hit and never re-queries the repository.
    await dispatchCache.get({ scopeLevel: 'GLOBAL', scopeRefCode: null, tenantId: null });
    expect(findByScopeSpy).not.toHaveBeenCalled();

    findByScopeSpy.mockRestore();
  });

  // TC-10.
  it('TC-10: an unknown cache key returns a defined 400 error — never a silent no-op that looks like success', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', ADMIN_HEADER())
      .send({ key: 'thisCacheNameDoesNotExist' });

    expect(response.status).toBe(400);
    // Never the same shape a successful call returns — no `invalidated` array pretending success.
    expect(response.body.invalidated).toBeUndefined();
    expect(recordSpy).not.toHaveBeenCalled();
  });
});
