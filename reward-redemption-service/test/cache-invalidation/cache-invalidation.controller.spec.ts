/**
 * T-RR-007 — `CacheInvalidationController`, exercised two ways:
 *  1. Against a standalone Nest testing module with a faked `CacheInvalidationService` — proves
 *     the guard's own `401` behaviour (TC-5) and that the controller is a thin pass-through (R10),
 *     without touching the real DB.
 *  2. Against the real, fully-wired `AppModule` and the real local Postgres server — this task's
 *     own verification steps 2/3 (`curl` a running dev instance; a real
 *     `cache_invalidation_audit` row appears), automated here rather than only manually run.
 */
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { CacheAdminAuthGuard } from '@/modules/cache-invalidation/cache-admin-auth.guard';
import { CacheInvalidationController } from '@/modules/cache-invalidation/cache-invalidation.controller';
import { CacheInvalidationService } from '@/modules/cache-invalidation/cache-invalidation.service';
import { createMigrationConnection } from '@/database/migration-connection';
import { MetricsRegistry } from '@/observability/metrics.registry';

describe('POST /api/v1/cache/invalidate (controller, faked service)', () => {
  let app: INestApplication;
  let invalidate: jest.Mock;

  beforeEach(async () => {
    invalidate = jest.fn().mockResolvedValue({
      invalidated: ['dispatchChannelConfig'],
      invalidatedAt: new Date().toISOString(),
    });
    const moduleRef = await Test.createTestingModule({
      controllers: [CacheInvalidationController],
      providers: [
        CacheAdminAuthGuard,
        { provide: CacheInvalidationService, useValue: { invalidate } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  // TC-5.
  it('TC-5: missing bearer token — 401, the service is never called', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .send({ all: true });

    expect(response.status).toBe(401);
    expect(invalidate).not.toHaveBeenCalled();
  });

  // TC-5.
  it('TC-5: wrong bearer token — 401, the service is never called', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', 'Bearer wrong-token')
      .send({ all: true });

    expect(response.status).toBe(401);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('a valid token delegates straight to the service and returns its response verbatim (R10)', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', `Bearer ${process.env.CACHE_ADMIN_TOKEN}`)
      .send({ key: 'dispatchChannelConfig' });

    expect(response.status).toBe(200);
    expect(response.body.invalidated).toEqual(['dispatchChannelConfig']);
    expect(invalidate).toHaveBeenCalledWith({ key: 'dispatchChannelConfig' }, 'cache-admin-token');
  });

  it('GET is rejected, never silently treated as POST', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/cache/invalidate');
    expect([404, 405]).toContain(response.status);
  });
});

describe('POST /api/v1/cache/invalidate (real AppModule + real Postgres — verification steps 2/3)', () => {
  let app: INestApplication;
  let migrationDb: Sequelize;

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
  });

  afterAll(async () => {
    await migrationDb.close();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('valid token + {"all": true} returns 200 and writes a cache_invalidation_audit row with cache_key = NULL', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const response = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', `Bearer ${process.env.CACHE_ADMIN_TOKEN}`)
      .send({ all: true });

    expect(response.status).toBe(200);
    // T-RR-054: campaignConfig (CampaignConfigCache, T-RR-022) is now the fifth real cache in the
    // {"all": true} sweep, alongside the original four T-RR-007 caches.
    expect(response.body.invalidated.sort()).toEqual(
      [
        'tenantSchemaConfig',
        'externalRewardSystemConfig',
        'dispatchChannelConfig',
        'serviceConfig',
        'campaignConfig',
      ].sort(),
    );

    const rows = await migrationDb.query<{ cache_key: string | null; invoked_by: string }>(
      'SELECT cache_key, invoked_by FROM reward_redemption.cache_invalidation_audit ORDER BY invoked_at DESC LIMIT 1',
      { type: QueryTypes.SELECT },
    );
    expect(rows[0].cache_key).toBeNull();
    expect(rows[0].invoked_by).toBe('cache-admin-token');

    // T-RR-060: end-to-end proof that `CacheInvalidationService` actually resolves a real
    // `MetricsRegistry` from the real `AppModule` DI graph (not just a hand-built unit-test
    // instance) and increments it — the module-wiring half of this defect's fix.
    const metrics = app.get(MetricsRegistry);
    expect(metrics.getCounterValue('cache_invalidation_total', { key: 'all' })).toBe(1);
  });

  it('an invalid token writes no audit row', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const before = await migrationDb.query<{ count: string }>(
      'SELECT count(*)::text FROM reward_redemption.cache_invalidation_audit',
      { type: QueryTypes.SELECT },
    );

    const response = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', 'Bearer not-the-real-token')
      .send({ all: true });

    const after = await migrationDb.query<{ count: string }>(
      'SELECT count(*)::text FROM reward_redemption.cache_invalidation_audit',
      { type: QueryTypes.SELECT },
    );

    expect(response.status).toBe(401);
    expect(after[0].count).toBe(before[0].count);
  });
});
