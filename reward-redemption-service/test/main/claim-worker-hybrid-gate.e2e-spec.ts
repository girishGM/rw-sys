/**
 * T-INT-047 — regression test for the defect this task fixes: `AppModule`/`src/main.ts` never
 * registered `ClaimWorkerModule` anywhere, so a real `received` `reward_redemption_entry` row was
 * never claimed by any live process (`tasks/T-INT-047-*.md`'s own "Evidence" section).
 *
 * Two things are proven here, deliberately NOT by letting `ClaimWorkerRootModule`'s own lifecycle
 * hooks run for real inside the general `npm test` suite:
 *
 * 1. **The wiring** — `startHybridBootstrap()` (`src/main.ts`) really does call the SAME exported
 *    `createClaimWorkerContext()` function `src/modules/processing/claim-worker.main.ts` (T-RR-058)
 *    already ships (this task's own R2: "invents no new transport-startup logic of its own"),
 *    gated by `CLAIM_WORKER_ENABLED`, with the identical default-OFF-in-hybrid convention
 *    `GRPC_SERVER_ENABLED`/`KAFKA_CONSUMER_ENABLED` already established
 *    (`test/main/hybrid-bootstrap.e2e-spec.ts`'s own TC-1). Proven by mocking the exact module
 *    boundary this task's own header names as the reused function and asserting the REAL,
 *    unmodified `src/main.ts` calls it (or doesn't) through a REAL `NestFactory.create(AppModule)` +
 *    `app.listen()` round trip — an "observable property" in AGENT-PROTOCOL.md §3's sense (the real
 *    call graph a real boot takes), not a re-implementation of the wiring under test.
 *
 * 2. **The hazard this deliberately does NOT reproduce inside the automated suite**:
 *    `createClaimWorkerContext()` (unlike `createKafkaConsumerContext()`) has no gate of its own —
 *    the instant it is actually invoked for real, `NestFactory.createApplicationContext()` runs the
 *    full Nest lifecycle, starting `ClaimWorkerService`'s real poll loop AND
 *    `CompletionSweepService`'s real, unscoped sweep loop (no `enabled` gate of its own) against the
 *    SHARED `reward_redemption_entry` table every other real-Postgres spec file in this repo also
 *    writes to concurrently — the exact same hazard `test/processing/claim-worker-module-di.e2e-spec.ts`'s
 *    own header (T-RR-058) already documents in full for the identical root module, and the reason
 *    that file's own regression test deliberately calls only `.compile()`, never
 *    `.init()`/`createApplicationContext()`. This file follows that same, already-established
 *    precedent for the same reason. This task's own Definition of Done — a `received` row actually
 *    reaching a real terminal/in-progress state — is instead proven by a REAL, manually-run local
 *    process, pasted into this task's own completion report "Verification steps" table; the DoD's
 *    own wording ("without any test-only bootstrap involved") already frames that as the canonical
 *    proof, not an automated spec against the shared table.
 */
import 'reflect-metadata';

// T-INT-047. Deliberately BEFORE the `@/main` import below (see that import's own comment) —
// `src/config/config.module.ts`'s own `NestConfigModule.forRoot({ validate: validateConfig, ... })`
// validates `process.env` **once**, synchronously, the moment `config.module.ts` is first
// `require`'d (that file's own header, T-RR-004/T-RR-050), which happens transitively the instant
// the `import { startHybridBootstrap, ... } from '@/main'` line below is evaluated — before any
// `it()` body in this file ever runs. `ConfigService.get('PORT', ...)` then always returns that ONE
// frozen, validated value for the rest of this file's own process lifetime; a later
// `process.env.PORT = ...` assignment inside `resetEnvToBaseline()` would have **no effect on it**
// (confirmed empirically while implementing this task — see `test/main/hybrid-bootstrap.
// e2e-spec.ts`'s own identical fix and comment for the full writeup: this suite's own real HTTP
// listener always bound `.env.development`'s literal `PORT=3030` otherwise, invisible as long as
// only one real-HTTP-listener-binding file existed in this whole suite, and a real, reproducible
// `EADDRINUSE :::3030` the moment this file — the second one — was added and Jest scheduled both
// into different parallel workers at the same wall-clock moment).
//
// Not literally `PORT=0` — `config.schema.ts`'s own `PORT: z.coerce.number().int().positive()`
// rejects `0` at this same synchronous validation step (confirmed empirically: "PORT: Number must
// be greater than 0"). A random, fixed-range port number picked once at module-load time (never
// `getFreePort()`, which is inherently async and cannot run before a synchronous, module-load-time
// statement) is this file's own low-collision substitute — this file's own range (`46000-50999`)
// is disjoint from `test/main/hybrid-bootstrap.e2e-spec.ts`'s own range, so the two real
// HTTP-listening files this suite now has can never collide with each other.
process.env.PORT = String(46_000 + Math.floor(Math.random() * 5_000));

import request from 'supertest';
import { getFreePort } from '../e2e/fixtures/reward-entry.fixtures';

const createClaimWorkerContextMock = jest.fn();

jest.mock('@/modules/processing/claim-worker.main', () => ({
  __esModule: true,
  createClaimWorkerContext: (...args: unknown[]) => createClaimWorkerContextMock(...args),
}));

// Imported AFTER the mock above so `src/main.ts`'s own `import { createClaimWorkerContext } from
// './modules/processing/claim-worker.main'` resolves to the mock within this file's own isolated
// Jest module registry (per-test-file, never affecting any other spec file in this suite).
import { startHybridBootstrap, HybridBootstrapError, type HybridBootstrapResult } from '@/main';

jest.setTimeout(30_000);

/** Same shape `test/main/hybrid-bootstrap.e2e-spec.ts`'s own `resetEnvToBaseline()` already
 * establishes — GRPC/Kafka both left disabled here too, since this file's own scope is the
 * claim-worker gate only; `CLAIM_WORKER_ENABLED` is reset explicitly by every test below instead of
 * here, so each one's own value under test is unambiguous. `PORT` is intentionally NOT reset here —
 * see the module-load-time `process.env.PORT = '0'` statement above this file's own `@/main` import
 * for why. */
async function resetEnvToBaseline(): Promise<void> {
  delete process.env.GRPC_SERVER_ENABLED;
  delete process.env.KAFKA_CONSUMER_ENABLED;
  delete process.env.CLAIM_WORKER_ENABLED;
  process.env.GRPC_SERVER_PORT = String(await getFreePort());
  process.env.GRPC_SERVER_TLS_CA_PATH = './dev-certs/ca.pem';
  process.env.GRPC_SERVER_TLS_CERT_PATH = './dev-certs/server-cert.pem';
  process.env.GRPC_SERVER_TLS_KEY_PATH = './dev-certs/server-key.pem';
  process.env.GRPC_SERVER_ALLOWED_IDENTITIES = 'placeholder-identity:1';
}

describe('T-INT-047 — src/main.ts hybrid bootstrap wires ClaimWorkerModule behind CLAIM_WORKER_ENABLED (e2e, real HTTP app, real Nest DI, mocked claim-worker context construction)', () => {
  beforeEach(() => {
    createClaimWorkerContextMock.mockReset();
  });

  // TC-1 (task file TC-2: "gate left at its default")
  it('TC-1: CLAIM_WORKER_ENABLED left unset — claimWorkerContext stays null, createClaimWorkerContext is never called, /health unaffected', async () => {
    await resetEnvToBaseline();

    const result: HybridBootstrapResult = await startHybridBootstrap();
    try {
      expect(result.claimWorkerContext).toBeNull();
      expect(createClaimWorkerContextMock).not.toHaveBeenCalled();

      const health = await request(result.httpApp.getHttpServer()).get('/health');
      expect(health.status).toBe(200);
    } finally {
      await result.httpApp.close();
    }
  });

  it('TC-2: CLAIM_WORKER_ENABLED=false — same as unset, claimWorkerContext stays null', async () => {
    await resetEnvToBaseline();
    process.env.CLAIM_WORKER_ENABLED = 'false';

    const result = await startHybridBootstrap();
    try {
      expect(result.claimWorkerContext).toBeNull();
      expect(createClaimWorkerContextMock).not.toHaveBeenCalled();
    } finally {
      await result.httpApp.close();
    }
  });

  // TC-3 (task file TC-1: "gate enabled" — the wiring half of that proof; the functional "claims
  // and processes a real row" half is this task's own real, manually-run local process instead,
  // per this file's own header).
  it('TC-3: CLAIM_WORKER_ENABLED=true — startHybridBootstrap calls the real, exported createClaimWorkerContext() exactly once and returns its handle', async () => {
    await resetEnvToBaseline();
    process.env.CLAIM_WORKER_ENABLED = 'true';

    const fakeContext = { close: jest.fn().mockResolvedValue(undefined) };
    createClaimWorkerContextMock.mockResolvedValue(fakeContext);

    const result = await startHybridBootstrap();
    try {
      expect(createClaimWorkerContextMock).toHaveBeenCalledTimes(1);
      expect(result.claimWorkerContext).toBe(fakeContext);

      const health = await request(result.httpApp.getHttpServer()).get('/health');
      expect(health.status).toBe(200);
    } finally {
      await fakeContext.close();
      await result.httpApp.close();
    }
  });

  // Implementation-note-4 parity with the two existing gates (TC-5 of
  // `test/main/hybrid-bootstrap.e2e-spec.ts`): an explicitly-enabled transport that fails to start
  // must be reported, and must never take the primary HTTP listener down with it.
  it('TC-4: CLAIM_WORKER_ENABLED=true but createClaimWorkerContext() rejects — reported as a HybridBootstrapError failure, httpApp still usable', async () => {
    await resetEnvToBaseline();
    process.env.CLAIM_WORKER_ENABLED = 'true';

    const boom = new Error('simulated claim-worker context construction failure');
    createClaimWorkerContextMock.mockRejectedValue(boom);

    let caught: HybridBootstrapError | undefined;
    try {
      await startHybridBootstrap();
      throw new Error('expected startHybridBootstrap() to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(HybridBootstrapError);
      caught = error as HybridBootstrapError;
    }

    try {
      expect(caught!.failures).toHaveLength(1);
      expect(caught!.failures[0].label).toContain('claim worker');
      expect(caught!.partial.claimWorkerContext).toBeNull();

      const health = await request(caught!.partial.httpApp.getHttpServer()).get('/health');
      expect(health.status).toBe(200);
    } finally {
      await caught?.partial.httpApp.close();
    }
  });
});
