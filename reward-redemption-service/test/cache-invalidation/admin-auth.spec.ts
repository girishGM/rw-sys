/**
 * T-RR-044 — admin-token auth hardening for `POST /api/v1/cache/invalidate`
 * (`06-CACHING-AND-TENANT-CONFIG.md` §3, `04-REST-CONTRACT.md` §4, implementation note 1).
 *
 * `test/security/token-separation.spec.ts` (T-RR-042) already proves the broader, service-wide
 * token-separation property across every inbound endpoint this service exposes. This file adds
 * cache-invalidation-specific depth to that same property, living in this task's own file scope
 * (`test/cache-invalidation/**`) rather than editing that file — T-RR-042's own file is not in this
 * task's "Files owned" list (R3), and this task's own scope note is explicit that this is a
 * deliberate, focused *regression* test, not a replacement for that broader audit.
 *
 * TC-1, TC-2 (`tasks/T-RR-044-cache-invalidation-hardening.md`).
 *
 * **"No audit row written" is asserted via an in-process spy on this app instance's own
 * `CacheInvalidationAuditRepository.record`, never a `cache_invalidation_audit` row-count
 * before/after comparison.** That table is shared by every concurrently-running real-Postgres spec
 * file under `test/cache-invalidation/**` (each with its own `AppModule` instance, all writing to
 * the same physical table) — a global count can change between this file's own "before" and
 * "after" reads purely because a *different* file's own request landed in that window, which is a
 * real, reproduced flake (confirmed by direct repeated runs), not a hypothetical one. Spying on
 * this process's own repository instance observes only calls this app instance itself made,
 * immune to that cross-file race, while still proving the exact causal property this test cares
 * about: the guard rejects before the service/repository is ever reached.
 */
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { CacheInvalidationAuditRepository } from '@/modules/cache-invalidation/cache-invalidation-audit.repository';

describe('T-RR-044 — POST /api/v1/cache/invalidate: admin-token auth hardening', () => {
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
    // A generous, explicit hook timeout — `app.close()` tears down every real `pg.Pool` this app
    // graph opened plus `ReconciliationPollerService.onModuleDestroy()`'s own in-flight refresh
    // cycle, which occasionally exceeds Jest's default 5000ms hook timeout under real, heavy
    // concurrent load against the shared local Postgres server (reproduced directly during this
    // task's own verification) — not a leak, just real teardown work needing real time.
  }, 15_000);

  beforeEach(() => {
    recordSpy.mockClear();
  });

  // TC-1.
  it('TC-1: no Authorization header at all — 401, and no audit row is written for the rejected call', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .send({ all: true });

    expect(response.status).toBe(401);
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('a malformed Authorization header (missing the "Bearer " prefix) — 401', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', process.env.CACHE_ADMIN_TOKEN ?? 'irrelevant')
      .send({ all: true });

    expect(response.status).toBe(401);
  });

  it('an empty bearer token — 401', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', 'Bearer ')
      .send({ all: true });

    expect(response.status).toBe(401);
  });

  // TC-2: three distinct, genuinely *valid* tokens for other endpoints — each must still be
  // rejected here. Rejected, not merely "not preferred" (implementation note 1's own framing).
  it.each([
    ['REWARD_ENTRY_INGEST_TOKEN', () => process.env.REWARD_ENTRY_INGEST_TOKEN, true],
    // GENERATION_SERVICE_TOKEN is an outbound-only credential this service presents to
    // promo-code-service — it has no configured real value anywhere in this local/test
    // environment (T-RR-042's own finding, `test/security/token-separation.spec.ts`), so a literal
    // stand-in value proves the guard rejects it on its own merits (never equal to the real
    // CACHE_ADMIN_TOKEN), not merely because it happens to be unset.
    ['GENERATION_SERVICE_TOKEN', () => 'T-RR-044-audit-generation-service-token-value', false],
    ['REWARD_TRACKING_REST_TOKEN', () => process.env.REWARD_TRACKING_REST_TOKEN, true],
  ])(
    'TC-2: a valid %s presented to this endpoint is rejected with 401 — never cross-usable',
    async (_name, getToken, expectConfigured) => {
      const token = getToken();
      if (expectConfigured) {
        expect(token).toBeTruthy();
      }

      const response = await request(app.getHttpServer())
        .post('/api/v1/cache/invalidate')
        .set('Authorization', `Bearer ${token}`)
        .send({ all: true });

      expect(response.status).toBe(401);
      expect(recordSpy).not.toHaveBeenCalled();
    },
  );

  // Sanity: proves the 401s above are real rejections from a working guard, not a guard that
  // rejects every request regardless of token.
  it('the real CACHE_ADMIN_TOKEN is accepted — 200', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', `Bearer ${process.env.CACHE_ADMIN_TOKEN}`)
      .send({ key: 'serviceConfig' });

    expect(response.status).toBe(200);
  });
});
