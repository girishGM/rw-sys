import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { HealthController } from '../src/health/health.controller';
import type { Config } from '../src/config/config.schema';

describe('GET /health (e2e)', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  // TC-6: "GET /health with the app booted and Postgres reachable → 200 with a JSON status
  // body." Boots the real `AppModule` (proving `ConfigModule` + `HealthModule` wiring, not just
  // the controller in isolation) against `DB_HOST`/`DB_PORT` from `test/jest-e2e.setup.ts`,
  // which point at the real Postgres 16 server documented in root CLAUDE.md — this asserts the
  // actual outcome a TCP client observes against that real server, not a mocked/stubbed
  // reachability result.
  it('returns 200 with an ok status when Postgres is reachable', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const response = await request(app.getHttpServer()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', db: 'reachable' });
  });

  // Negative case: DB_PORT pointed at a closed local port must fail the readiness check —
  // proves the /health endpoint's DB probe is a real, falsifiable check, not one that reports
  // "ok" unconditionally. Port 1 is a well-known reserved (unassignable) port, never accepting
  // TCP connections on any dev machine.
  //
  // Builds a minimal module with `HealthController` and a stand-in `ConfigService` as SIBLING
  // providers (not the whole `AppModule`/`ConfigModule`) rather than mutating
  // `process.env.DB_PORT` between tests: `NestConfigModule.forRoot` parses and validates the
  // environment once, synchronously, the first time `config.module.ts` is imported (see that
  // file's header and `jest-e2e.setup.ts`) — a later `process.env` write has no effect on the
  // already-cached `ConfigService` values, so this is the only way to exercise the
  // "unreachable" branch without a second real, deliberately-broken Postgres to point at.
  // Declaring the controller directly here (rather than importing `HealthModule`, which relies
  // on `ConfigService` being registered globally by `AppModule` in production) keeps this
  // stand-in in the same module as the controller that consumes it — Nest only resolves a
  // dependency from providers visible to the requesting module, not from a sibling test
  // module's own provider list.
  it('returns 503 with a degraded status when Postgres is unreachable', async () => {
    const fakeConfig: Pick<ConfigService<Config, true>, 'get'> = {
      get: ((key: keyof Config) => {
        const values: Partial<Config> = { DB_HOST: '127.0.0.1', DB_PORT: 1 };
        return values[key];
      }) as ConfigService<Config, true>['get'],
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: ConfigService, useValue: fakeConfig }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const response = await request(app.getHttpServer()).get('/health');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'degraded', db: 'unreachable' });
  });
});
