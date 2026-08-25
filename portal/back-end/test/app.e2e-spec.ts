import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';

describe('AppModule (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.getHttpAdapter().getInstance().disable('x-powered-by');
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    // T-085: `app.init()` alone never binds a TCP listener, so `request(app.getHttpServer())`
    // below made supertest itself call `server.listen(0)`/`server.close()` once per request — see
    // `test/e2e-infra/bound-http-server.e2e-spec.ts` for the reproduction and
    // `test/security/support/bound-app.ts`'s header comment for the full write-up of the failure
    // mode this caused elsewhere. `listen(0)` binds once, here, before any request runs; Nest's
    // `listen()` already calls `init()` internally, so this both replaces and satisfies the call
    // above.
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health -> 200 { status: "ok" }, no version/dependency detail', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('does not send an X-Powered-By header', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
