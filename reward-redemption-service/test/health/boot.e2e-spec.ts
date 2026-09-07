import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module';

/**
 * TC-3/TC-7 (T-RR-001): the scaffold actually boots as a real Nest application and `GET /health`
 * answers `200` — proving `AppModule`'s wiring end to end (`ConfigModule` + `HealthModule`), not
 * just a controller in isolation. Updated in place by T-RR-004 (superseding, not duplicating,
 * T-RR-001's own trivial DB-unaware assertion) once the real, config-driven health check
 * (process liveness + raw DB TCP reachability) replaced `AppController`'s placeholder — this
 * file keeps asserting the boot-level contract even though `test/health/health.e2e-spec.ts` now
 * covers the richer TC-3..TC-6 matrix in full.
 */
describe('App boot (e2e)', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  it('boots AppModule and GET /health returns 200 with an ok, reachable status', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const response = await request(app.getHttpServer()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', db: 'reachable' });
  });
});
