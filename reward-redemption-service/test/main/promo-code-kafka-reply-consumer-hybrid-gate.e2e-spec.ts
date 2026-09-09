/**
 * T-INT-053 — regression test for the defect this task fixes: `PromoCodeServiceKafkaClient.start()`
 * (`src/modules/connectors/promo-code-service-kafka.client.ts`, T-RR-081) was never called from any
 * real running process, so `requestAndAwaitReply()` could never resolve a real Kafka reply and every
 * Kafka-primary `rr-to-promo-code` redemption exhausted its full retry budget instead
 * (`tasks/T-INT-053-*.md`'s own "Evidence" section — five real, fast, successful promo-code-service
 * replies, zero of them ever received by this service).
 *
 * Same deliberate testing discipline `test/main/claim-worker-hybrid-gate.e2e-spec.ts` (T-INT-047)
 * already establishes for the analogous `CLAIM_WORKER_ENABLED` gate, for the identical reason: this
 * gate's own real dependency, `createClaimWorkerContext()`, has no gate of its own — the instant it
 * is actually invoked for real, `NestFactory.createApplicationContext()` runs the full Nest
 * lifecycle, starting `ClaimWorkerService`'s real poll loop AND `CompletionSweepService`'s real,
 * unscoped sweep loop against the SHARED `reward_redemption_entry` table every other real-Postgres
 * spec file in this repo also writes to concurrently. So `createClaimWorkerContext()` is mocked here
 * too — this file proves the WIRING (the real, unmodified `src/main.ts`, through a real
 * `NestFactory.create(AppModule)` + `app.listen()` round trip, resolves `PromoCodeServiceKafkaClient`
 * from the exact SAME context handle `CLAIM_WORKER_ENABLED` already constructs, and calls the real,
 * unmocked `.start()` method on it — an "observable property" in `AGENT-PROTOCOL.md` §3's sense, the
 * real call graph a real boot takes), not a re-implementation of the wiring under test. The real
 * Kafka round trip itself (a real reply actually resolving a real pending `requestAndAwaitReply()`
 * promise) is already proven, with no broker required, by `test/connectors/promo-code-service-kafka
 * .client.spec.ts` (T-RR-081) — this file's own job is narrower and different: prove `src/main.ts`
 * actually calls `.start()` on the correct instance, which that other file cannot prove on its own
 * since it never touches `src/main.ts`. The full real-broker, real-promo-code-service, real-Postgres
 * end-to-end proof is this task's own completion report's "Verification steps" table (a real,
 * manually-run local process), matching the identical, already-established precedent
 * `claim-worker-hybrid-gate.e2e-spec.ts`'s own header documents in full for the same reason.
 *
 * `PromoCodeServiceKafkaClient` itself is NOT mocked (unlike `createClaimWorkerContext`) — the fake
 * context's own `.get()` returns a real instance (constructed directly, bypassing DI, with a fake
 * `Kafka`-less `ConfigService`/`ServiceConfigResolverService`) whose own real `start()` method is
 * spied on via `jest.spyOn`, so this suite asserts the real method got called, not merely a
 * hand-rolled stand-in with the same name.
 */
import 'reflect-metadata';

// T-INT-053. Deliberately BEFORE the `@/main` import below — see
// `test/main/claim-worker-hybrid-gate.e2e-spec.ts`'s own identical comment (T-INT-047) for the full
// mechanism: `src/config/config.module.ts`'s own `NestConfigModule.forRoot(...)` validates
// `process.env` once, synchronously, the moment `config.module.ts` is first `require`'d — which
// happens transitively the instant this file's own `import { startHybridBootstrap, ... } from
// '@/main'` line below is evaluated, before any `it()` body in this file ever runs. This file's own
// port range (`41000-45999`) is disjoint from every other real-HTTP-listener-binding file in this
// suite (`hybrid-bootstrap.e2e-spec.ts`: 52000-56999, `claim-worker-hybrid-gate.e2e-spec.ts`:
// 46000-50999) so none of the three can ever collide with each other.
process.env.PORT = String(41_000 + Math.floor(Math.random() * 5_000));

import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { getFreePort } from '../e2e/fixtures/reward-entry.fixtures';
import { PromoCodeServiceKafkaClient } from '@/modules/connectors/promo-code-service-kafka.client';
import type { Config } from '@/config/config.schema';

const createClaimWorkerContextMock = jest.fn();

jest.mock('@/modules/processing/claim-worker.main', () => ({
  __esModule: true,
  createClaimWorkerContext: (...args: unknown[]) => createClaimWorkerContextMock(...args),
}));

// Imported AFTER the mock above so `src/main.ts`'s own `import { createClaimWorkerContext } from
// './modules/processing/claim-worker.main'` resolves to the mock within this file's own isolated
// Jest module registry — same precedent `claim-worker-hybrid-gate.e2e-spec.ts` already sets.
import { startHybridBootstrap, HybridBootstrapError, type HybridBootstrapResult } from '@/main';

jest.setTimeout(30_000);

/** A real `PromoCodeServiceKafkaClient` instance, constructed directly (bypassing Nest DI —
 * `claimWorkerContext.get(...)` is mocked to return this exact instance below), with `start()`
 * replaced by a spy so tests can assert it was called without ever opening a real broker
 * connection. `stop()` is left real (a no-op when `this.consumer` was never set, since `start()`
 * itself is mocked here). */
function fakePromoCodeServiceKafkaClient(): {
  client: PromoCodeServiceKafkaClient;
  startSpy: jest.SpyInstance<Promise<void>, []>;
} {
  const fakeConfigService = { get: () => 'localhost:9094' } as unknown as ConfigService<
    Config,
    true
  >;
  const fakeServiceConfig = { resolve: jest.fn().mockResolvedValue(10_000) };
  const client = new PromoCodeServiceKafkaClient(fakeConfigService, fakeServiceConfig);
  const startSpy = jest.spyOn(client, 'start').mockResolvedValue(undefined);
  return { client, startSpy };
}

/** Same shape `claim-worker-hybrid-gate.e2e-spec.ts`'s own `resetEnvToBaseline()` already
 * establishes — GRPC/Kafka(-ingest) both left disabled here too, since this file's own scope is the
 * promo-code Kafka reply-consumer gate (and its `CLAIM_WORKER_ENABLED` dependency) only. `PORT` is
 * intentionally NOT reset here — see the module-load-time `process.env.PORT` statement above this
 * file's own `@/main` import for why. */
async function resetEnvToBaseline(): Promise<void> {
  delete process.env.GRPC_SERVER_ENABLED;
  delete process.env.KAFKA_CONSUMER_ENABLED;
  delete process.env.CLAIM_WORKER_ENABLED;
  delete process.env.PROMO_CODE_KAFKA_REPLY_CONSUMER_ENABLED;
  process.env.GRPC_SERVER_PORT = String(await getFreePort());
  process.env.GRPC_SERVER_TLS_CA_PATH = './dev-certs/ca.pem';
  process.env.GRPC_SERVER_TLS_CERT_PATH = './dev-certs/server-cert.pem';
  process.env.GRPC_SERVER_TLS_KEY_PATH = './dev-certs/server-key.pem';
  process.env.GRPC_SERVER_ALLOWED_IDENTITIES = 'placeholder-identity:1';
}

describe('T-INT-053 — src/main.ts hybrid bootstrap wires PromoCodeServiceKafkaClient.start() behind PROMO_CODE_KAFKA_REPLY_CONSUMER_ENABLED (e2e, real HTTP app, real Nest DI, mocked claim-worker context construction)', () => {
  beforeEach(() => {
    createClaimWorkerContextMock.mockReset();
  });

  // TC-2 (task file): gate left at its default.
  it('TC-1: PROMO_CODE_KAFKA_REPLY_CONSUMER_ENABLED left unset — stays null, createClaimWorkerContext is never called, /health unaffected', async () => {
    await resetEnvToBaseline();

    const result: HybridBootstrapResult = await startHybridBootstrap();
    try {
      expect(result.promoCodeKafkaReplyConsumer).toBeNull();
      expect(result.claimWorkerContext).toBeNull();
      expect(createClaimWorkerContextMock).not.toHaveBeenCalled();

      const health = await request(result.httpApp.getHttpServer()).get('/health');
      expect(health.status).toBe(200);
    } finally {
      await result.httpApp.close();
    }
  });

  it('TC-1b: PROMO_CODE_KAFKA_REPLY_CONSUMER_ENABLED=false — same as unset', async () => {
    await resetEnvToBaseline();
    process.env.PROMO_CODE_KAFKA_REPLY_CONSUMER_ENABLED = 'false';
    process.env.CLAIM_WORKER_ENABLED = 'true';
    const { client } = fakePromoCodeServiceKafkaClient();
    const fakeContext = {
      get: jest.fn().mockReturnValue(client),
      close: jest.fn().mockResolvedValue(undefined),
    };
    createClaimWorkerContextMock.mockResolvedValue(fakeContext);

    const result = await startHybridBootstrap();
    try {
      expect(result.promoCodeKafkaReplyConsumer).toBeNull();
      expect(fakeContext.get).not.toHaveBeenCalledWith(PromoCodeServiceKafkaClient);
    } finally {
      await fakeContext.close();
      await result.httpApp.close();
    }
  });

  // TC-1 (task file): gate enabled, real end-to-end proof of the reply actually arriving is this
  // task's own manually-run local process (this file's own header) — the wiring half proven here.
  it('TC-2: both gates true — resolves PromoCodeServiceKafkaClient from the SAME claimWorkerContext handle and calls the real .start()', async () => {
    await resetEnvToBaseline();
    process.env.CLAIM_WORKER_ENABLED = 'true';
    process.env.PROMO_CODE_KAFKA_REPLY_CONSUMER_ENABLED = 'true';

    const { client, startSpy } = fakePromoCodeServiceKafkaClient();
    const fakeContext = {
      get: jest.fn().mockReturnValue(client),
      close: jest.fn().mockResolvedValue(undefined),
    };
    createClaimWorkerContextMock.mockResolvedValue(fakeContext);

    const result = await startHybridBootstrap();
    try {
      expect(createClaimWorkerContextMock).toHaveBeenCalledTimes(1);
      // The critical, load-bearing property this task's own header documents: resolved from the
      // SAME context handle, never a second, independently-constructed one.
      expect(result.claimWorkerContext).toBe(fakeContext);
      expect(fakeContext.get).toHaveBeenCalledWith(PromoCodeServiceKafkaClient);
      expect(result.promoCodeKafkaReplyConsumer).toBe(client);
      expect(startSpy).toHaveBeenCalledTimes(1);

      const health = await request(result.httpApp.getHttpServer()).get('/health');
      expect(health.status).toBe(200);
    } finally {
      await fakeContext.close();
      await result.httpApp.close();
    }
  });

  // Discovered while implementing (AGENT-PROTOCOL.md §3: "test cases in the task file are the
  // minimum, not the target"): the one real hazard this gate's own design has to guard against —
  // an operator enabling the reply consumer without the claim worker in the same process, which
  // would silently start a consumer that can never resolve anything (this file's own header /
  // src/main.ts's own header have the full "in-memory, per-instance registry" reasoning).
  it('TC-3 (guard): PROMO_CODE_KAFKA_REPLY_CONSUMER_ENABLED=true with CLAIM_WORKER_ENABLED left unset — rejects with a clear HybridBootstrapError, httpApp still usable, createClaimWorkerContext never called', async () => {
    await resetEnvToBaseline();
    process.env.PROMO_CODE_KAFKA_REPLY_CONSUMER_ENABLED = 'true';
    // CLAIM_WORKER_ENABLED deliberately left unset.

    let caught: HybridBootstrapError | undefined;
    try {
      await startHybridBootstrap();
      throw new Error('expected startHybridBootstrap() to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(HybridBootstrapError);
      caught = error as HybridBootstrapError;
    }

    try {
      expect(createClaimWorkerContextMock).not.toHaveBeenCalled();
      expect(caught!.failures).toHaveLength(1);
      expect(caught!.failures[0].label).toContain('promo-code.generate.result.v1');
      expect(String((caught!.failures[0].error as Error).message)).toContain(
        'CLAIM_WORKER_ENABLED=true',
      );
      expect(caught!.partial.promoCodeKafkaReplyConsumer).toBeNull();
      expect(caught!.partial.claimWorkerContext).toBeNull();

      const health = await request(caught!.partial.httpApp.getHttpServer()).get('/health');
      expect(health.status).toBe(200);
    } finally {
      await caught?.partial.httpApp.close();
    }
  });

  // TC-4 (task file, regression): mirrors the identical implementation-note-4 parity every other
  // gate's own suite already proves (TC-5 of `hybrid-bootstrap.e2e-spec.ts`, TC-4 of
  // `claim-worker-hybrid-gate.e2e-spec.ts`) — a transport that IS explicitly enabled but fails to
  // start must be reported, never silently swallowed, and must never take httpApp down with it.
  it('TC-4 (regression parity): PromoCodeServiceKafkaClient.start() rejecting is reported as a HybridBootstrapError failure, httpApp still usable', async () => {
    await resetEnvToBaseline();
    process.env.CLAIM_WORKER_ENABLED = 'true';
    process.env.PROMO_CODE_KAFKA_REPLY_CONSUMER_ENABLED = 'true';

    const { client, startSpy } = fakePromoCodeServiceKafkaClient();
    const boom = new Error('simulated broker connection failure');
    startSpy.mockRejectedValue(boom);
    const fakeContext = {
      get: jest.fn().mockReturnValue(client),
      close: jest.fn().mockResolvedValue(undefined),
    };
    createClaimWorkerContextMock.mockResolvedValue(fakeContext);

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
      expect(caught!.failures[0].label).toContain('promo-code.generate.result.v1');
      expect(caught!.failures[0].error).toBe(boom);
      expect(caught!.partial.promoCodeKafkaReplyConsumer).toBeNull();
      // The claim worker itself still started successfully — only the reply consumer failed.
      expect(caught!.partial.claimWorkerContext).toBe(fakeContext);

      const health = await request(caught!.partial.httpApp.getHttpServer()).get('/health');
      expect(health.status).toBe(200);
    } finally {
      await fakeContext.close();
      await caught?.partial.httpApp.close();
    }
  });
});
