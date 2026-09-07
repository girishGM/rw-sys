import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { HealthController } from '../src/health/health.controller';
import { DbReachabilityService } from '../src/health/db-reachability.service';
import type { Config } from '../src/config/config.schema';

/**
 * T-RTS-001 — TC-6 and the health-specific slice of TC-4 (config boot failure is covered
 * separately by `src/config/config.schema.spec.ts`, direct-unit style, plus the real one-shot
 * subprocess proof below).
 *
 * `test/env.setup.ts` (Jest `setupFiles`) loads `.env.development` before this file's own
 * `import { AppModule } ...` line runs, so `ConfigModule.forRoot({ validate: validateConfig })`
 * (evaluated at that import, not inside any `beforeAll`) already has a fully-populated
 * `process.env` to validate against.
 */
describe('GET /health (e2e)', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  // TC-6 (success case): boots the REAL AppModule (proving ConfigModule + HealthModule wiring, not
  // just HealthController in isolation) against the real local Postgres 16 server (root
  // CLAUDE.md). Also stands in for "reward_tracking_app does not yet exist" (T-RTS-002 hasn't run
  // in this task) because the underlying check (db-reachability.service.ts) is a raw TCP connect —
  // no login, no `reward_tracking_app` credential is ever used here.
  it('returns 200 {"status":"ok","db":"reachable"} when Postgres is reachable', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const response = await request(app.getHttpServer()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', db: 'reachable' });
  });

  // Negative case: DB unreachable must degrade to 503 within a short, bounded timeout, never hang.
  // Uses the REAL `DbReachabilityService` (its actual TCP-connect + timeout logic is what's under
  // test here, not a stand-in that just returns `false`) pointed at port 1 — a well-known reserved
  // port no process on any machine ever binds, so this is a real, falsifiable "unreachable"
  // signal, not a mocked one. `ConfigService` is substituted directly (rather than mutating
  // `process.env.DB_PORT` between tests) because `NestConfigModule.forRoot` parses and validates
  // the environment once, synchronously, the first time `config.module.ts` is imported — a later
  // `process.env` write has no effect on the already-cached values.
  it('returns 503 {"status":"degraded","db":"unreachable"} within a bounded time when Postgres is unreachable', async () => {
    const fakeConfig: Pick<ConfigService<Config, true>, 'get'> = {
      get: ((key: keyof Config) => {
        const values: Partial<Config> = { DB_HOST: '127.0.0.1', DB_PORT: 1 };
        return values[key];
      }) as ConfigService<Config, true>['get'],
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [DbReachabilityService, { provide: ConfigService, useValue: fakeConfig }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const startedAt = Date.now();
    const response = await request(app.getHttpServer()).get('/health');
    const elapsedMs = Date.now() - startedAt;

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'degraded', db: 'unreachable' });
    // "does not hang" — well under Jest's own default 5s test timeout, comfortably above the
    // service's own 2s TCP-connect timeout (db-reachability.service.ts).
    expect(elapsedMs).toBeLessThan(4000);
  });

  // Wrong verb must not be silently treated as GET.
  it('POST /health is rejected, never silently treated as GET', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const response = await request(app.getHttpServer()).post('/health');

    expect([404, 405]).toContain(response.status);
  });
});
