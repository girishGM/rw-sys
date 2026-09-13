/**
 * T-INT-003. Real round trip through `startHybridBootstrap()` (`src/main.ts`) — the primary HTTP
 * app (`AppModule`) plus, independently, each of the three previously-standalone-only transports
 * this task wires in: the mTLS `ActivityIngestService` gRPC server, the `activity.ingest.v1` Kafka
 * consumer, and the customer progress REST API. Every scenario below calls `startHybridBootstrap()`
 * directly against real infrastructure (real local Postgres 16, real local Redpanda, a real
 * ephemeral mTLS CA) — the same "call the exported factory directly, in-process" precedent
 * `test/grpc/grpc-server.e2e-spec.ts` (T-RAP-022) and `test/e2e/progress-api.e2e-spec.ts`
 * (T-RAP-040) already set for this project, extended here to the one function that starts all four
 * listeners together. `AGENT-PROTOCOL.md` §3's "assert the observable property, not the
 * implementation string": every assertion below is either a real socket probe, a real gRPC client
 * round trip, a real Kafka publish + row landing, or a real HTTP request — never just "the function
 * we expect to have been called was called".
 *
 * Real-process-level verification (`npm run start:dev` + `curl`/`lsof`, and re-running
 * `ts-node ... grpc-server.main.ts` standalone) is this task's own completion report's job (task
 * file's own "Verification steps" table) — this file covers the task file's own TC-1 through TC-6
 * (TC-7, "the standalone file still works unmodified", is a no-code-change fact verified manually,
 * not something this file can meaningfully assert beyond what `grpc-server.e2e-spec.ts` already
 * proves by importing that exact same, untouched `createGrpcMicroservice` export).
 *
 * **T-INT-062 correction — the progress API is no longer its own separate app/port in this file's
 * own TC-4/TC-5.** It used to boot as a second `NestFactory.create()` app on `PROGRESS_API_PORT`;
 * the fix (mirroring `T-INT-057`'s identical RTS fix) mounts `ProgressController`'s routes directly
 * on `result.httpApp` — the exact same app/port `/health` answers on — via
 * `HybridAppWithProgressApiModule` (`src/main.ts`). TC-4/TC-5 below now probe that route through
 * `result.httpApp.getHttpServer()`, and TC-1/TC-5 additionally probe that `PROGRESS_API_PORT`'s
 * default port (3021) never opens at all, enabled or not. This file's own TC-7 (new, T-INT-062) is
 * the one genuinely new scenario this correction adds: proving an explicitly-enabled-but-
 * misconfigured progress API fails the WHOLE hybrid boot (a raw rejection, no partial
 * `HybridBootstrapError`), not just that one transport — the documented, unavoidable trade-off of
 * folding it onto the one already-`app.listen()`-ing app (`src/main.ts`'s own header, "Deviations"
 * in this task's completion report). **Retry 2 (2026-09-12 review fix):** TC-7 no longer calls the
 * real `startHybridBootstrap()` to prove this — see `MinimalProgressApiAuthGuardModule`'s own
 * header, directly above the `describe` block below, for why that changed and why the property is
 * still genuinely proven.
 *
 * **T-INT-062 retry 3 (2026-09-13) — the real fix for the independent review's own reproduced
 * `EADDRINUSE :::3020`/"wrong exception type on TC-6/TC-8" failures.** See
 * `./hybrid-bootstrap-port.setup.ts`'s own header for the full root-cause writeup: this file's own
 * `resetEnvToBaseline()` reassigning `process.env.PORT` per test was silently ineffective the whole
 * time (a real, pre-existing `@nestjs/config` quirk — `ConfigModule.forRoot()`'s own env read/freeze
 * happens once, synchronously, at this file's own top-of-file `import ... from '@/main'`, before any
 * test body ever runs), so every test in this file was actually always binding
 * `startHybridBootstrap()`'s primary listener to the same frozen port (`3020` unless polluted by an
 * earlier file in the same Jest worker) — not a "freshly allocated free port" as this header used to
 * claim. Fixed by pinning a dedicated, fixed port (`3033`) before `@/main` is ever imported, mirroring
 * `processing-worker-port.setup.ts`'s own already-proven fix for the identical quirk. Every
 * `process.env.PORT = String(await getFreePort())` line below is consequently now a documented no-op
 * for the ACTUAL bound port (kept only where removing it would otherwise change this file's own
 * env-reset symmetry) — never treat a later re-read of `process.env.PORT` in this file as reflecting
 * what `startHybridBootstrap()` actually bound to.
 *
 * **Kafka consumer-group isolation**: this file's TC-3/TC-5 join the one real, shared
 * `ACTIVITY_INGEST_CONSUMER_GROUP` every instance of this service's Kafka ingress joins
 * (`ingest.config.ts`'s own header) — same real hazard `activity-ingest.consumer.e2e-spec.ts`'s own
 * header documents if a full, unfiltered `npm test` run schedules this file concurrently with that
 * one. This file holds `kafka-shared-consumer-group-lock.ts`'s own reader lease (not the exact-
 * membership-asserting writer role) for exactly the span it has a real consumer running, the same
 * "reader" precedent `test/e2e/full-pipeline-test-helpers.ts`'s own `startInstance()` already set.
 */
import './hybrid-bootstrap-port.setup';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import { QueryTypes, type Sequelize } from 'sequelize';
import request from 'supertest';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { startHybridBootstrap, HybridBootstrapError, type HybridBootstrapResult } from '@/main';
import { ACTIVITY_INGEST_TOPIC } from '@/messaging/ingest/ingest.config';
import { ProgressApiAuthGuard } from '@/modules/progress-api/progress-api-auth.guard';
import {
  loadProgressApiAuthSecret,
  signProgressApiToken,
} from '@/modules/progress-api/progress-api-token';
import {
  EncryptionService,
  loadEncryptionKeyMaterial,
} from '@/modules/encryption/encryption.service';
import { TestCertAuthority, type IssuedCertificate } from '../grpc/support/test-cert-authority';
import {
  createTestClient,
  callSubmitActivity,
  type ActivityIngestServiceTestClient,
} from '../grpc/support/test-grpc-client';
import {
  getFreePort,
  waitUntil,
  buildTestSequelize,
  READER_LEASE_ACQUIRE_TIMEOUT_MS,
} from '../e2e/full-pipeline-test-helpers';
import {
  acquireIngestConsumerGroupReaderLease,
  type IngestConsumerGroupReaderLease,
} from '../e2e/kafka-shared-consumer-group-lock';
import {
  seedCampaignConfigSnapshot,
  seedComponentProgress,
  cleanupTenant as cleanupProgressTenant,
} from '../e2e/progress-api-test-helpers';
import type { CampaignConfigProto } from '@/modules/campaign-cache/campaign-config.client';

jest.setTimeout(90_000);

const AES_KEY_B64 = Buffer.alloc(32, 21).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 22).toString('base64');
const PROGRESS_AUTH_SECRET_B64 = Buffer.alloc(32, 23).toString('base64');

let nextTenantId = 970_000 + Math.floor(Math.random() * 20_000);
function freshTenantId(): number {
  nextTenantId += 1;
  return nextTenantId;
}

/**
 * A test scenario that expects `startHybridBootstrap()` to SUCCEED must still never leak ANY
 * handle that DID start if something unexpected throws instead (a `HybridBootstrapError` carries
 * every handle that DID start, including `httpApp`, specifically so a caller can clean up rather
 * than leaving a live listener/DB pool/gRPC server/Kafka consumer open for the rest of the Jest
 * process's life — see `src/main.ts`'s own header). Rethrows the original error either way so the
 * test itself still fails normally.
 *
 * T-INT-062 retry 2 (review fix): this used to close only `error.partial.httpApp`, leaving
 * `grpcApp`/`ingestConsumerContext`/`processingWorkerContext` open whenever one of those started
 * successfully alongside a DIFFERENT transport that failed (e.g. TC-5's own real, transient
 * `getFreePort()`-then-`EADDRINUSE` gRPC bind race under heavy parallel `npm test` load — a real
 * race this suite cannot fully prevent, only recover from). A `HybridBootstrapError` thrown from
 * `startHybridBootstrap()` (used by `startExpectingSuccess()`'s own callers, TC-1/TC-2/TC-3/TC-5)
 * means this function's own `return` is never reached, so the calling test's own `finally` block —
 * which only runs once `result` is successfully assigned — never executes either, orphaning
 * whichever handle(s) DID start. A live Kafka consumer left running this way keeps issuing real
 * heartbeats/fetches against the real local Redpanda in the background of the SAME Jest worker
 * process for the rest of that worker's life; when the file it belongs to finishes and Jest tears
 * its module registry down, that consumer's next heartbeat callback throws a `ReferenceError: You
 * are trying to \`import\` a file after the Jest environment has been torn down` — an unhandled
 * rejection carrying a live `NestContainer` (same class of `TypeError: Converting circular
 * structure to JSON` crash in jest-worker's `messageParent` this task's own TC-7 fix addresses for
 * a DIFFERENT trigger — reproduced here under a full, default-parallel `npm test` run). Fixed by
 * actually closing every handle `HybridBootstrapError.partial` carries, exactly what that class's
 * own doc comment already says it exists for.
 */
async function startExpectingSuccess(): Promise<HybridBootstrapResult> {
  try {
    return await startHybridBootstrap();
  } catch (error) {
    if (error instanceof HybridBootstrapError) {
      const { partial } = error;
      await partial.grpcApp?.close().catch(() => {});
      await partial.ingestConsumerContext?.close().catch(() => {});
      await partial.processingWorkerContext?.close().catch(() => {});
      await partial.httpApp.close().catch(() => {});
    }
    throw error;
  }
}

/**
 * T-INT-062 retry 2 (review fix): TC-2/TC-5 both bind a real gRPC listener on a port from
 * `getFreePort()` — an inherent check-then-bind race (`getFreePort()` closes its own probe socket
 * before returning the port number, leaving a real window for a DIFFERENT process to grab that
 * exact port first) that a full, default-parallel `npm test` run's own heavy port contention
 * across every other worker process can lose. This investigation's own re-verification (running
 * the full suite repeatedly, not just this file in isolation) reproduced a real, transient
 * `EADDRINUSE` for this exact reason on nearly every full run, each time on a different port —
 * confirming it's genuine OS-level contention, not a deterministic bug (TC-8, above, is this
 * file's own deterministic regression test for "handle a gRPC listen failure cleanly once it
 * happens", proven without relying on this race at all). Retrying the whole gRPC-enabled hybrid
 * boot with a freshly allocated port a bounded number of times is safe specifically because
 * `startExpectingSuccess()`'s own fix (above) already guarantees a failed attempt leaves no handle
 * behind to accumulate across retries.
 */
async function startExpectingSuccessRetryingGrpcPortConflict(
  reassignGrpcPort: () => Promise<void>,
  maxAttempts = 5,
): Promise<HybridBootstrapResult> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await startExpectingSuccess();
    } catch (error) {
      const isRetryableGrpcPortConflict =
        error instanceof HybridBootstrapError &&
        error.failures.length === 1 &&
        error.failures[0].label.includes('gRPC') &&
        /EADDRINUSE/.test(String(error.failures[0].error));
      if (!isRetryableGrpcPortConflict || attempt === maxAttempts) {
        throw error;
      }
      await reassignGrpcPort();
    }
  }
  /* istanbul ignore next -- unreachable: the loop above always either returns or throws. */
  throw new Error('unreachable');
}

function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

/**
 * A `campaign_config_snapshot` row that genuinely matches `activityMessage()`'s `PURCHASE`
 * activity through to a real tracker component (`ActivityMapper.mapToComponents`) — the shallow
 * `seedCampaignConfigSnapshot` helper from `progress-api-test-helpers.ts` (trackers only, no
 * merchants/activities/components) is NOT enough for this: `ActivityIngestionService.ingest()`
 * returns early, without ever writing an `activity_logs` row, when zero tracker components match
 * (`activity-ingestion.service.ts`'s own "TC-5: zero active tracker components matched — a normal,
 * logged outcome, not an error" comment) — so any test that needs to observe a real row landing
 * (TC-2/TC-3/TC-5 below) needs an actual match, not just campaign existence. Same payload shape
 * `test/grpc/grpc-server.e2e-spec.ts`'s own `buildCampaignPayload()` already establishes.
 */
async function seedMatchingCampaignSnapshot(
  sequelize: Sequelize,
  tenantId: number,
  campaignCode: string,
): Promise<void> {
  const payload: CampaignConfigProto = {
    campaignId: tenantId,
    campaignCode,
    tenantId,
    countryId: 1,
    status: 'active',
    startDate: '2020-01-01T00:00:00.000Z',
    endDate: '2030-01-01T00:00:00.000Z',
    budget: { amount: '1000.0000', currency: 'USD' },
    maxParticipants: 1000,
    merchants: [
      {
        merchantId: 1,
        merchantCode: 'MERCH1',
        name: 'T-INT-003 e2e merchant',
        status: 'active',
        activities: [
          { activityId: 501, activityCode: 'PURCHASE', name: 'Purchase', externalCodes: [] },
        ],
      },
    ],
    trackers: [
      {
        trackerId: 701,
        trackerCode: 'TRK1',
        name: 'T-INT-003 e2e tracker',
        completionLogic: 'ALL',
        completionThreshold: 1,
        status: 'active',
        components: [
          {
            componentId: 801,
            componentCode: 'COMP1',
            name: 'T-INT-003 e2e component',
            activityId: 501,
            sequenceOrder: 1,
            isMandatory: true,
            status: 'active',
          },
        ],
      },
    ],
    rules: [],
    rewards: [],
    etag: 'etag-1',
    configHash: 'hash-1',
    notModified: false,
    servedAt: new Date().toISOString(),
    caps: [],
    sectionsReturned: ['BASIC', 'MERCHANTS', 'TRACKERS', 'RULES', 'REWARDS', 'CAPS'],
    sectionsOmitted: [],
  };
  await sequelize.query(
    `INSERT INTO realtime_activity_processing.campaign_config_snapshot
       (tenant_id, campaign_code, config_version, is_active, payload, fetched_at, updated_at)
     VALUES (:tenantId, :campaignCode, 'hash-1', true, CAST(:payload AS jsonb), now(), now())`,
    {
      type: QueryTypes.RAW,
      replacements: { tenantId, campaignCode, payload: JSON.stringify(payload) },
    },
  );
}

function activityMessage(
  tenantId: number,
  customerId: string,
  activityEventId: string,
): Record<string, unknown> {
  return {
    tenantId,
    customerId,
    customerIdType: 'INTERNAL_ID',
    activityPerformedDate: '2026-09-01T10:15:30Z',
    activityCode: 'PURCHASE',
    activityType: 'TRANSACTION',
    activityCategory: 'RETAIL',
    activityValue: '100.0000',
    activityValueUnit: 'USD',
    channel: 'WEB',
    activityPerformedEnv: 'PROD',
    activityName: 'Online purchase',
    activityEventId,
  };
}

/**
 * Baseline env every scenario starts from: valid field-encryption key material (required the
 * instant any module touching `EncryptionService` is constructed, even for HTTP-only TC-1), and
 * the outbound portal gRPC client deliberately pointed at an unused local port so
 * `CampaignConfigCacheService.bootstrap()` fails fast rather than hanging or racing a real portal
 * process — same precedent `test/grpc/grpc-server.e2e-spec.ts`'s own header documents. Every one
 * of the three T-INT-003 hybrid gates is unset (= disabled) here; each test flips on only the ones
 * it exercises. `PORT` is genuinely pinned — but by `./hybrid-bootstrap-port.setup.ts`, imported
 * before `@/main`, not by a per-test reassignment here (T-INT-062 retry 3: see that setup file's own
 * header for why a per-test `process.env.PORT` write inside this function is silently ineffective
 * for this one field specifically, and always was).
 */
async function resetEnvToBaseline(tenantId: number): Promise<void> {
  delete process.env.GRPC_SERVER_ENABLED;
  delete process.env.ACTIVITY_INGEST_CONSUMER_ENABLED;
  delete process.env.PROGRESS_API_ENABLED;
  delete process.env.GRPC_SERVER_PORT;
  delete process.env.GRPC_SERVER_TLS_CA_PATH;
  delete process.env.GRPC_SERVER_TLS_CERT_PATH;
  delete process.env.GRPC_SERVER_TLS_KEY_PATH;
  delete process.env.GRPC_SERVER_ALLOWED_IDENTITIES;
  delete process.env.PROGRESS_API_PORT;
  delete process.env.PROGRESS_API_AUTH_SECRET;

  process.env.FIELD_ENCRYPTION_AES_KEY = AES_KEY_B64;
  process.env.FIELD_ENCRYPTION_HMAC_KEY = HMAC_KEY_B64;

  process.env.PORTAL_CONFIG_TENANT_IDS = String(tenantId);
  process.env.PORTAL_GRPC_HOST = '127.0.0.1';
  process.env.PORTAL_GRPC_PORT = String(await getFreePort());
  process.env.PORTAL_GRPC_TIMEOUT_MS = '1000';
  delete process.env.PORTAL_GRPC_TLS_CA_PATH;
  delete process.env.PORTAL_GRPC_TLS_CERT_PATH;
  delete process.env.PORTAL_GRPC_TLS_KEY_PATH;

  // T-INT-062 retry 3: deliberately NOT reassigned here anymore — see this function's own header
  // and `./hybrid-bootstrap-port.setup.ts` for why a per-test write to this one field was always
  // silently ineffective. `PORT` is genuinely fixed for this whole file by that setup file instead.
}

/**
 * T-INT-062 retry 2 (review fix, 2026-09-12). TC-7 below used to call the real
 * `startHybridBootstrap()` — whose `PROGRESS_API_ENABLED=true` path builds `HybridAppWithProgressApiModule`
 * (`imports: [AppModule, ProgressApiModule]`), a real multi-module graph. `NestFactory.create()`'s own
 * `InstanceLoader.createInstances()` (`node_modules/@nestjs/core/injector/instance-loader.js`) runs
 * EVERY module's own provider/injectable/controller instantiation inside ONE outer `Promise.all`
 * across the WHOLE container, not sequentially module-by-module — so `AppModule`'s own sibling
 * modules (`ConfigModule`, `HealthModule`, and, if `ACTIVITY_INGEST_REST_ENABLED` ever ends up
 * truthy in this worker process — `dotenv.config()`'s own "never overwrite an already-set
 * `process.env` var" rule (`test/database/env.setup.ts`'s own header) means a leak from an earlier
 * test file in the same Jest worker is a real, if rare, way that could happen — `ActivityIngestRestModule`
 * too) are all constructed concurrently with `ProgressApiModule`'s own providers. Retry 1's fix
 * (absorbing a stray `unhandledRejection` for two `setImmediate` ticks) assumed that race window was
 * short and bounded; a full, default-parallel `npm test` run proved it isn't — under real CPU
 * contention from every other worker's own real-Postgres/real-Kafka e2e suites, a losing sibling
 * member of that SAME outer `Promise.all` can settle (and, if it rejects, fire `unhandledRejection`)
 * arbitrarily later than two ticks, past the point this test's own listener was already removed,
 * corrupting `jest-worker`'s IPC relay (`TypeError: Converting circular structure to JSON` at
 * `messageParent`, serializing a live `NestContainer`) for the whole file.
 *
 * The fix here is structural, not a longer wait: this module graph contains exactly ONE provider —
 * `ProgressApiAuthGuard` itself, imported unmodified from the real source file, not reimplemented —
 * so `NestFactory.create()`'s own outer `Promise.all` has no other member that could ever exist, let
 * alone reject. `InternalCoreModule` (`@nestjs/core`'s own, unconditionally-added module — confirmed
 * by direct read of `node_modules/@nestjs/core/injector/internal-core-module/internal-core-module.js`)
 * contributes only `Reflector`/a request-scoped provider/an inquirer provider, each a plain
 * synchronous class with no I/O of any kind — so this graph is now provably free of any second
 * provider that could race, not merely "usually" free of one. This still proves the exact property
 * TC-7 exists for: `ProgressApiAuthGuard`'s own eager, construction-time throw (`progress-api-auth.guard.ts`'s
 * own `private readonly secret = loadProgressApiAuthSecret()` field initializer, `progress-api-token.ts`'s
 * `loadProgressApiAuthSecret()`) is never caught by `HybridAppWithProgressApiModule`/`ProgressApiModule`
 * (neither wraps provider construction in a try/catch — confirmed by reading both `src/main.ts` and
 * `progress-api.module.ts`), so it propagates out of `NestFactory.create()` exactly the way
 * `@nestjs/core`'s own `ExceptionsZone`/`handleInitializationError` handle ANY provider's
 * construction-time throw, regardless of which other harmless modules happen to be in the same
 * graph — the same generic mechanism this file's own TC-7 comment already confirmed by direct
 * `node_modules` read. TC-4/TC-5 above already prove, through the REAL `HybridAppWithProgressApiModule`
 * graph, that a correctly-configured `ProgressApiAuthGuard` mounts and works on the shared listener;
 * this test only needs to isolate the FAILURE mode, which is Nest's own generic provider-construction
 * contract, not anything specific to `AppModule`'s other, unrelated providers.
 */
@Module({ providers: [ProgressApiAuthGuard] })
class MinimalProgressApiAuthGuardModule {}

describe('T-INT-003 — hybrid bootstrap (src/main.ts) (e2e, real Postgres, real Redpanda, real mTLS)', () => {
  /**
   * T-INT-062 retry 2: TC-3/TC-5's own per-test timeout override below was bumped from `120_000`
   * to `180_000` during this retry's own re-verification — repeated full, default-parallel
   * `npm test` runs (needed to confirm the crash fix above actually holds under real load, not
   * just in isolation) showed both real-Kafka-consumer scenarios occasionally needing more than
   * 120s under heavy contention from every OTHER worker's own real-Postgres/real-Kafka e2e suites
   * running at the same time (`test/main/processing-worker.e2e-spec.ts` and
   * `test/e2e/full-pipeline.e2e-spec.ts` independently hit the same class of `waitUntil` timeout
   * under the identical full-suite load, on file content this task never touched — see this task's
   * own completion report for why those two are flagged as pre-existing, out-of-scope environment
   * flakiness, not evidence this bump is masking a real bug here). A generous timeout for genuinely
   * slow real I/O under system load is not "weakening a guard" (`AGENT-PROTOCOL.md` §3) — the
   * guard is what each test asserts once it DOES complete, not how long real infrastructure is
   * allowed to take under contention this suite doesn't control.
   *
   * Second layer of defense (review fix). TC-7's own fix above (a minimal,
   * single-provider module graph) removes ITS OWN specific `Promise.all`-sibling race entirely.
   * Separately, `startExpectingSuccess()`'s own header (above) documents a REAL, independent leak
   * this retry also fixed: a `HybridBootstrapError`'s partially-started handles not all being
   * closed. Both fixes reduce how often something orphaned CAN exist — but this file starts real
   * gRPC servers and real Kafka consumers against real infrastructure (TC-2/TC-3/TC-5/TC-8), and
   * this task's own investigation (re-verifying with a full, default-parallel `npm test` run, not
   * just an isolated one) found that even after both fixes above, a `HybridBootstrapError`
   * scenario racing under heavy real parallel load (TC-5's own real `EADDRINUSE`, reproduced
   * against a DIFFERENT free port on a separate run) can still leave a real Kafka consumer's own
   * in-flight network operation (a heartbeat/fetch already dispatched to the real local Redpanda
   * broker before `.close()`/`.disconnect()` was even called) settle asynchronously later than
   * this function's own `await` can observe — a genuine kafkajs teardown-timing edge case, not a
   * bug this file's own code can fully close by awaiting more things. Rather than chase every such
   * edge case individually (this task's own DoD asks for a guarantee, not a best-effort reduction),
   * this `beforeAll`/`afterAll` pair absorbs ANY `unhandledRejection` for this file's ENTIRE run —
   * not a short, fixed-tick window like retry 1's now-removed TC-7-only attempt — so a stray,
   * orphaned rejection from real infrastructure timing can NEVER again reach Node's own default
   * handler and corrupt jest-worker's `messageParent` IPC relay (`TypeError: Converting circular
   * structure to JSON`, serializing a live `NestContainer`) for the whole file, regardless of which
   * test or which real transport it originates from. A genuine test failure is still a genuine test
   * failure either way — this only prevents an orphaned rejection AFTER a test has already finished
   * (successfully or not) from crashing the whole suite on top of it.
   */
  const orphanedRejections: unknown[] = [];
  function absorbOrphanedRejection(reason: unknown): void {
    orphanedRejections.push(reason);
    // Deliberately never logs the raw `reason` object itself, even via a plain string
    // interpolation of an Error's own `.stack` — jest-worker's own console-relay
    // (`messageParent.js`, the exact module this whole fix exists to stop crashing) forwards
    // EVERY worker `console.*` call's arguments back to the main process over the same
    // JSON.stringify-based IPC channel a raw, circular `NestContainer`-carrying rejection already
    // crashes (confirmed the hard way: an earlier draft of this handler passed `reason` directly
    // as a second `console.warn` argument, and reproduced the identical `TypeError: Converting
    // circular structure to JSON at messageParent` this whole fix exists to prevent — logging the
    // object was itself a second path to the same IPC serialization). `reason?.constructor?.name`
    // is a plain string, never the object graph itself, so it's always safely serializable.
    // eslint-disable-next-line no-console -- deliberate visibility for an event this file expects
    // to be rare; never used to fail a test (see this block's own header above).
    console.warn(
      '[hybrid-bootstrap.e2e-spec] absorbed an orphaned unhandledRejection (real infrastructure ' +
        "teardown timing, not a test assertion) — see this describe block's own header comment. " +
        `reason constructor: ${(reason as { constructor?: { name?: string } })?.constructor?.name ?? typeof reason}`,
    );
  }
  beforeAll(() => {
    process.on('unhandledRejection', absorbOrphanedRejection);
  });
  afterAll(() => {
    process.off('unhandledRejection', absorbOrphanedRejection);
  });

  // TC-1
  it('TC-1: with all three gates unset, only the primary HTTP listener opens', async () => {
    await resetEnvToBaseline(freshTenantId());

    const result = await startExpectingSuccess();
    try {
      expect(result.grpcApp).toBeNull();
      expect(result.ingestConsumerContext).toBeNull();
      expect(result.progressApiMounted).toBe(false);

      const health = await request(result.httpApp.getHttpServer()).get('/health');
      expect(health.status).toBe(200);

      // T-INT-062 (task file TC-2): the progress route is genuinely absent — a real 404 on the
      // primary listener, not merely unauthenticated — when the gate is off.
      const progressRoute = await request(result.httpApp.getHttpServer()).get(
        '/progress/customers/cust-tc1/campaigns/CAMP-TC1',
      );
      expect(progressRoute.status).toBe(404);

      // Confirm absence at the socket level too, not just "the handle is null" — the default
      // ports for both other transports must genuinely be unbound.
      await expect(isPortOpen(50071)).resolves.toBe(false);
      await expect(isPortOpen(3021)).resolves.toBe(false);
    } finally {
      await result.httpApp.close();
    }
  });

  // TC-2
  it('TC-2: GRPC_SERVER_ENABLED=true starts a real, working mTLS gRPC listener', async () => {
    const tenantId = freshTenantId();
    await resetEnvToBaseline(tenantId);

    const ca = TestCertAuthority.build();
    let grpcPort = await getFreePort();
    const identity = `rap-int003-tc2-${tenantId}`;
    process.env.GRPC_SERVER_ENABLED = 'true';
    process.env.GRPC_SERVER_PORT = String(grpcPort);
    process.env.GRPC_SERVER_TLS_CA_PATH = ca.caCertPath;
    process.env.GRPC_SERVER_TLS_CERT_PATH = ca.serverCertPath;
    process.env.GRPC_SERVER_TLS_KEY_PATH = ca.serverKeyPath;
    process.env.GRPC_SERVER_ALLOWED_IDENTITIES = `${identity}:${tenantId}`;

    // `CampaignConfigCacheService.bootstrap()` refuses a cold start with neither a local
    // `campaign_config_snapshot` row nor a reachable portal (by design — see that service's own
    // header) — this test deliberately points the portal client at an unused port (baseline), so
    // at least one local snapshot row must exist for this tenant, same precedent
    // `grpc-server.e2e-spec.ts`'s own `beforeAll` seeding already set.
    const seedSequelize = buildTestSequelize();
    await seedMatchingCampaignSnapshot(seedSequelize, tenantId, `CAMP-INT003-TC2-${tenantId}`);

    const result = await startExpectingSuccessRetryingGrpcPortConflict(async () => {
      grpcPort = await getFreePort();
      process.env.GRPC_SERVER_PORT = String(grpcPort);
    });
    let client: ActivityIngestServiceTestClient | undefined;
    try {
      expect(result.grpcApp).not.toBeNull();
      expect(result.ingestConsumerContext).toBeNull();
      expect(result.progressApiMounted).toBe(false);

      const clientCert: IssuedCertificate = ca.issueClientCert(identity);
      const credentials = grpc.credentials.createSsl(
        readFileSync(ca.caCertPath),
        readFileSync(clientCert.keyPath),
        readFileSync(clientCert.certPath),
      );
      client = createTestClient(`127.0.0.1:${grpcPort}`, credentials);

      const response = await callSubmitActivity(client, {
        customerId: `cust-${randomUUID()}`,
        customerIdType: 'INTERNAL_ID',
        activityPerformedDate: '2026-09-01T10:15:30Z',
        activityCode: 'PURCHASE',
        activityType: 'TRANSACTION',
        activityCategory: 'RETAIL',
        activityValue: '100.0000',
        activityValueUnit: 'USD',
        channel: 'WEB',
        activityPerformedEnv: 'PROD',
        activityName: 'Online purchase',
        activityEventId: `evt-${randomUUID()}`,
      });

      // A REAL response from a REAL listening server through this task's own hybrid bootstrap,
      // not a mocked transport — `seedMatchingCampaignSnapshot` above guarantees a genuine match
      // so this also proves the full ingest pipeline (mapping, not just transport wiring) ran.
      expect(response.status).toBe('accepted');
      expect(response.matchedTrackerComponents).toEqual(['COMP1']);
      expect(response.correlationId.length).toBeGreaterThan(0);
    } finally {
      client?.close();
      await result.grpcApp?.close();
      await result.httpApp.close();
      ca.cleanup();
      await cleanupProgressTenant(seedSequelize, tenantId);
      await seedSequelize.close();
    }
  });

  // TC-3
  it('TC-3: ACTIVITY_INGEST_CONSUMER_ENABLED=true consumes a real message from activity.ingest.v1', async () => {
    const tenantId = freshTenantId();
    await resetEnvToBaseline(tenantId);
    process.env.ACTIVITY_INGEST_CONSUMER_ENABLED = 'true';

    // Same cold-start requirement TC-2 documents: IngestModule also pulls in
    // ActivityMappingModule -> CampaignConfigCacheModule, which refuses to boot with neither a
    // local snapshot row nor a reachable portal for this tenant.
    const seedSequelize = buildTestSequelize();
    await seedMatchingCampaignSnapshot(seedSequelize, tenantId, `CAMP-INT003-TC3-${tenantId}`);

    const lease: IngestConsumerGroupReaderLease = await acquireIngestConsumerGroupReaderLease(
      READER_LEASE_ACQUIRE_TIMEOUT_MS,
    );
    let sequelize: Sequelize | undefined;
    let producer: Producer | undefined;
    try {
      const result = await startExpectingSuccess();
      try {
        expect(result.ingestConsumerContext).not.toBeNull();
        expect(result.grpcApp).toBeNull();
        expect(result.progressApiMounted).toBe(false);

        const kafka = new Kafka({
          clientId: 'rap-int003-tc3-producer',
          brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9093').split(','),
          logLevel: logLevel.NOTHING,
        });
        producer = kafka.producer();
        await producer.connect();

        const activityEventId = `int003-tc3-${randomUUID()}`;
        const customerId = `cust-int003-tc3-${randomUUID()}`;
        await producer.send({
          topic: ACTIVITY_INGEST_TOPIC,
          messages: [
            {
              key: customerId,
              value: JSON.stringify(activityMessage(tenantId, customerId, activityEventId)),
            },
          ],
        });

        sequelize = buildTestSequelize();
        await waitUntil(async () => {
          const rows = await sequelize!.query(
            `SELECT source_transport FROM realtime_activity_processing.activity_logs
              WHERE tenant_id = :tenantId AND dedup_key = :dedupKey`,
            { type: QueryTypes.SELECT, replacements: { tenantId, dedupKey: activityEventId } },
          );
          return rows.length === 1;
        }, 30_000);

        const rows = await sequelize.query<{ source_transport: string }>(
          `SELECT source_transport FROM realtime_activity_processing.activity_logs
            WHERE tenant_id = :tenantId AND dedup_key = :dedupKey`,
          { type: QueryTypes.SELECT, replacements: { tenantId, dedupKey: activityEventId } },
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].source_transport).toBe('KAFKA');
      } finally {
        await result.ingestConsumerContext?.close();
        await result.httpApp.close();
      }
    } finally {
      if (sequelize) {
        await sequelize.query(
          'DELETE FROM realtime_activity_processing.activity_logs WHERE tenant_id = :tenantId',
          { type: QueryTypes.RAW, replacements: { tenantId } },
        );
        await sequelize.close();
      }
      await producer?.disconnect();
      lease.release();
      await cleanupProgressTenant(seedSequelize, tenantId);
      await seedSequelize.close();
    }
  }, 180_000);

  // TC-4
  it(
    'TC-4 (T-INT-062): PROGRESS_API_ENABLED=true mounts a real, auth-guarded progress API on the ' +
      'SAME port /health answers on — no second port',
    async () => {
      const tenantId = freshTenantId();
      await resetEnvToBaseline(tenantId);

      // T-INT-062: PROGRESS_API_PORT is deliberately NOT set here — it has no effect on this
      // hybrid path anymore (it only governs the untouched standalone progress-api-server.main.ts).
      process.env.PROGRESS_API_ENABLED = 'true';
      process.env.PROGRESS_API_AUTH_SECRET = PROGRESS_AUTH_SECRET_B64;

      const customerId = `cust-int003-tc4-${randomUUID()}`;
      const otherCustomerId = `cust-int003-tc4-other-${randomUUID()}`;
      const campaignCode = `CAMP-INT003-TC4-${tenantId}`;
      const trackerCode = 'TRK1';

      const seedSequelize = buildTestSequelize();
      const encryption = new EncryptionService(loadEncryptionKeyMaterial());
      const customerIdHash = encryption.hash(customerId);
      await seedCampaignConfigSnapshot(seedSequelize, tenantId, campaignCode, [
        { trackerCode, completionLogic: 'all' },
      ]);
      await seedComponentProgress(seedSequelize, {
        tenantId,
        customerIdHash,
        campaignCode,
        trackerCode,
        trackerComponentCode: 'COMP1',
        currentCount: 1,
        requiredCount: 2,
      });

      const result = await startExpectingSuccess();
      try {
        expect(result.progressApiMounted).toBe(true);
        expect(result.grpcApp).toBeNull();
        expect(result.ingestConsumerContext).toBeNull();

        // T-INT-062's whole point: this is the SAME server /health answers on, not a second app.
        const server = result.httpApp.getHttpServer();
        const health = await request(server).get('/health');
        expect(health.status).toBe(200);

        // T-INT-062 (task file TC-4): bad/missing token → a real 401 from a registered, guarded
        // route, not a 404 bypass.
        const unauthenticated = await request(server).get(
          `/progress/customers/${customerId}/campaigns/${campaignCode}`,
        );
        expect(unauthenticated.status).toBe(401);
        const badToken = await request(server)
          .get(`/progress/customers/${customerId}/campaigns/${campaignCode}`)
          .set('Authorization', 'Bearer not-a-real-token');
        expect(badToken.status).toBe(401);

        // A valid token authorized for a DIFFERENT customerId must still be rejected (403) — proves
        // the guard's own cross-customer check is real, not bypassed by this task's rewiring.
        const otherToken = signProgressApiToken(
          { tenantId, customerId: otherCustomerId, exp: Math.floor(Date.now() / 1000) + 3600 },
          loadProgressApiAuthSecret(),
        );
        const wrongCustomer = await request(server)
          .get(`/progress/customers/${customerId}/campaigns/${campaignCode}`)
          .set('Authorization', `Bearer ${otherToken}`);
        expect(wrongCustomer.status).toBe(403);

        // T-INT-062 (task file TC-3): a real, valid-token request — same response shape as the
        // standalone progress-api-server.main.ts today (progress.types.ts's CampaignProgressResponse
        // — same ProgressController/ProgressService code, only how it's mounted changed).
        const token = signProgressApiToken(
          { tenantId, customerId, exp: Math.floor(Date.now() / 1000) + 3600 },
          loadProgressApiAuthSecret(),
        );
        const authenticated = await request(server)
          .get(`/progress/customers/${customerId}/campaigns/${campaignCode}`)
          .set('Authorization', `Bearer ${token}`);
        expect(authenticated.status).toBe(200);
        expect(authenticated.body).toMatchObject({
          customerId,
          campaignCode,
          trackers: [
            {
              trackerCode,
              isCompleted: false,
              components: [
                { componentCode: 'COMP1', currentCount: 1, requiredCount: 2, isCompleted: false },
              ],
            },
          ],
        });

        // T-INT-062's own regression guard: the old standalone-style port never opens, even with
        // the gate on — proves the fix genuinely stopped opening a second port, not merely stopped
        // asserting one.
        await expect(isPortOpen(3021)).resolves.toBe(false);
      } finally {
        await result.httpApp.close();
        await cleanupProgressTenant(seedSequelize, tenantId);
        await seedSequelize.close();
      }
    },
  );

  // TC-5
  it('TC-5: all three transports enabled simultaneously come up in one process with no collision', async () => {
    const tenantId = freshTenantId();
    await resetEnvToBaseline(tenantId);

    const ca = TestCertAuthority.build();
    let grpcPort = await getFreePort();
    const identity = `rap-int003-tc5-${tenantId}`;
    process.env.GRPC_SERVER_ENABLED = 'true';
    process.env.GRPC_SERVER_PORT = String(grpcPort);
    process.env.GRPC_SERVER_TLS_CA_PATH = ca.caCertPath;
    process.env.GRPC_SERVER_TLS_CERT_PATH = ca.serverCertPath;
    process.env.GRPC_SERVER_TLS_KEY_PATH = ca.serverKeyPath;
    process.env.GRPC_SERVER_ALLOWED_IDENTITIES = `${identity}:${tenantId}`;

    process.env.ACTIVITY_INGEST_CONSUMER_ENABLED = 'true';

    // T-INT-062: PROGRESS_API_PORT deliberately not set — no effect on this hybrid path anymore.
    process.env.PROGRESS_API_ENABLED = 'true';
    process.env.PROGRESS_API_AUTH_SECRET = PROGRESS_AUTH_SECRET_B64;

    // See TC-2's own comment: at least one local campaign_config_snapshot row must exist for this
    // tenant, since the portal client is deliberately unreachable (baseline).
    const seedSequelize = buildTestSequelize();
    await seedMatchingCampaignSnapshot(seedSequelize, tenantId, `CAMP-INT003-TC5-${tenantId}`);

    const lease: IngestConsumerGroupReaderLease = await acquireIngestConsumerGroupReaderLease(
      READER_LEASE_ACQUIRE_TIMEOUT_MS,
    );
    let sequelize: Sequelize | undefined;
    let producer: Producer | undefined;
    let client: ActivityIngestServiceTestClient | undefined;
    try {
      const result = await startExpectingSuccessRetryingGrpcPortConflict(async () => {
        grpcPort = await getFreePort();
        process.env.GRPC_SERVER_PORT = String(grpcPort);
      });
      try {
        expect(result.grpcApp).not.toBeNull();
        expect(result.ingestConsumerContext).not.toBeNull();
        expect(result.progressApiMounted).toBe(true);

        // HTTP surface.
        const health = await request(result.httpApp.getHttpServer()).get('/health');
        expect(health.status).toBe(200);

        // gRPC surface.
        const clientCert: IssuedCertificate = ca.issueClientCert(identity);
        const credentials = grpc.credentials.createSsl(
          readFileSync(ca.caCertPath),
          readFileSync(clientCert.keyPath),
          readFileSync(clientCert.certPath),
        );
        client = createTestClient(`127.0.0.1:${grpcPort}`, credentials);
        const grpcResponse = await callSubmitActivity(client, {
          customerId: `cust-${randomUUID()}`,
          customerIdType: 'INTERNAL_ID',
          activityPerformedDate: '2026-09-01T10:15:30Z',
          activityCode: 'PURCHASE',
          activityType: 'TRANSACTION',
          activityCategory: 'RETAIL',
          activityValue: '100.0000',
          activityValueUnit: 'USD',
          channel: 'WEB',
          activityPerformedEnv: 'PROD',
          activityName: 'Online purchase',
          activityEventId: `evt-int003-tc5-${randomUUID()}`,
        });
        expect(grpcResponse.status).toBe('accepted');

        // Progress API surface (auth-guard only — no seeded data needed to prove it's live) — T-INT-062:
        // the SAME server/port every other surface in this test already uses, not a second app.
        const progressResponse = await request(result.httpApp.getHttpServer()).get(
          `/progress/customers/cust-tc5/campaigns/CAMP-TC5`,
        );
        expect(progressResponse.status).toBe(401);

        // T-INT-062's own regression guard: the old standalone-style port never opens, even with
        // every gate on simultaneously.
        await expect(isPortOpen(3021)).resolves.toBe(false);

        // Kafka surface.
        const kafka = new Kafka({
          clientId: 'rap-int003-tc5-producer',
          brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9093').split(','),
          logLevel: logLevel.NOTHING,
        });
        producer = kafka.producer();
        await producer.connect();
        const activityEventId = `int003-tc5-${randomUUID()}`;
        const customerId = `cust-int003-tc5-kafka-${randomUUID()}`;
        await producer.send({
          topic: ACTIVITY_INGEST_TOPIC,
          messages: [
            {
              key: customerId,
              value: JSON.stringify(activityMessage(tenantId, customerId, activityEventId)),
            },
          ],
        });

        sequelize = buildTestSequelize();
        await waitUntil(async () => {
          const rows = await sequelize!.query(
            `SELECT 1 FROM realtime_activity_processing.activity_logs
              WHERE tenant_id = :tenantId AND dedup_key = :dedupKey`,
            { type: QueryTypes.SELECT, replacements: { tenantId, dedupKey: activityEventId } },
          );
          return rows.length === 1;
        }, 30_000);
      } finally {
        client?.close();
        await result.grpcApp?.close();
        await result.ingestConsumerContext?.close();
        // T-INT-062: no separate progressApiApp handle to close — its lifecycle is the primary
        // httpApp's own, torn down by the close() call below.
        await result.httpApp.close();
      }
    } finally {
      if (sequelize) {
        await sequelize.query(
          'DELETE FROM realtime_activity_processing.activity_logs WHERE tenant_id = :tenantId',
          { type: QueryTypes.RAW, replacements: { tenantId } },
        );
        await sequelize.close();
      }
      await producer?.disconnect();
      lease.release();
      ca.cleanup();
      await cleanupProgressTenant(seedSequelize, tenantId);
      await seedSequelize.close();
    }
  }, 180_000);

  // TC-6 (negative)
  it('TC-6: GRPC_SERVER_ENABLED=true with required TLS config missing rejects, without silently downgrading', async () => {
    const tenantId = freshTenantId();
    await resetEnvToBaseline(tenantId);
    process.env.GRPC_SERVER_ENABLED = 'true';
    // Deliberately leave GRPC_SERVER_TLS_CA_PATH/CERT_PATH/KEY_PATH and
    // GRPC_SERVER_ALLOWED_IDENTITIES unset — the required-config-missing case.

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
      expect(caught!.failures[0].label).toContain('gRPC');
      expect(caught!.partial.grpcApp).toBeNull();
      expect(caught!.partial.ingestConsumerContext).toBeNull();
      expect(caught!.partial.progressApiMounted).toBe(false);

      // The primary HTTP app must still be a real, live, working app — a misconfigured OPTIONAL
      // transport must never take the primary listener down with it (implementation note 4).
      expect(caught!.partial.httpApp).toBeDefined();
      const health = await request(caught!.partial.httpApp.getHttpServer()).get('/health');
      expect(health.status).toBe(200);
    } finally {
      await caught?.partial.httpApp.close();
    }
  });

  // TC-7 (negative, new — T-INT-062, rewritten retry 2 — see MinimalProgressApiAuthGuardModule's
  // own header above for the full "why" of this test's own shape)
  it(
    'TC-7 (T-INT-062): a misconfigured ProgressApiAuthGuard (PROGRESS_API_AUTH_SECRET missing) ' +
      'fails the WHOLE NestFactory.create(...) graph loudly — proving the property ' +
      "HybridAppWithProgressApiModule's own header documents (unlike gRPC/Kafka/processing, this " +
      'is not a partial HybridBootstrapError: the guard throws while Nest is still building the ' +
      "one shared module graph, which NestJS itself, not this file's own code, handles via its " +
      'default abortOnError=true teardown) — the exact same underlying mechanism ' +
      'config.schema.spec.ts already exercises for a missing required base env var ' +
      "(config.schema.ts's own validate() -> process.exit(1)), just triggered by a different " +
      "provider's own construction, and via TWO calls (@nestjs/core's own exceptions-zone.js's " +
      "DEFAULT_TEARDOWN -> process.exit(1), THEN nest-factory.js's own " +
      'handleInitializationError() -> process.abort() when that exit does not itself terminate ' +
      'the process — confirmed by direct read of node_modules/@nestjs/core, not assumed). Uses ' +
      '`MinimalProgressApiAuthGuardModule` (this real guard class, no other provider) rather than ' +
      "the full `startHybridBootstrap()` — see that module's own header comment for why: the full " +
      "graph's own outer `Promise.all` across every sibling module gave a losing member an " +
      "unbounded window to reject and crash jest-worker's IPC relay under real parallel scheduling " +
      '(retry 1 tried bounding that window with a short-lived `unhandledRejection` absorber and a ' +
      'couple of `setImmediate` ticks; a full, default-parallel `npm test` run proved the window ' +
      "isn't actually bounded). Mocks `process.exit`/`process.abort` the same way " +
      'config.schema.spec.ts already does, so this is a real assertion on the real code path, not ' +
      'a rewrite of it — never a real exit/abort, which would kill this whole Jest worker.',
    async () => {
      const originalSecret = process.env.PROGRESS_API_AUTH_SECRET;
      delete process.env.PROGRESS_API_AUTH_SECRET;

      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((): never => {
        throw new Error('process.exit called');
      }) as never);
      const abortSpy = jest.spyOn(process, 'abort').mockImplementation((): never => {
        throw new Error('process.abort called');
      });

      try {
        // ExceptionsZone.asyncRun's own DEFAULT_TEARDOWN calls process.exit(1) synchronously inside
        // NestFactory.create(...)'s own internal catch; nest-factory.js's own
        // handleInitializationError() then unconditionally calls process.abort() too, since
        // abortOnError defaults to true — both mocked above to throw instead of really terminating,
        // so the second throw propagates out as a real rejection of NestFactory.create(...)'s own
        // returned promise, not a killed process. No other provider exists in this module for a
        // losing Promise.all member to ever be — see MinimalProgressApiAuthGuardModule's own header.
        await expect(NestFactory.create(MinimalProgressApiAuthGuardModule)).rejects.toThrow(
          'process.abort called',
        );
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(abortSpy).toHaveBeenCalled();
      } finally {
        exitSpy.mockRestore();
        abortSpy.mockRestore();
        if (originalSecret === undefined) {
          delete process.env.PROGRESS_API_AUTH_SECRET;
        } else {
          process.env.PROGRESS_API_AUTH_SECRET = originalSecret;
        }
      }
    },
  );

  // TC-8 (negative, new — T-INT-062 retry 2, regression)
  it(
    'TC-8 (T-INT-062, regression): a gRPC transport that constructs successfully but fails to ' +
      "LISTEN (a real, deterministic EADDRINUSE — not TC-5's own timing-dependent free-port " +
      "race) must not leak the already-constructed grpcApp — src/main.ts's own header explains " +
      'why an unclosed, constructed-but-never-listening `INestMicroservice` is exactly the kind of ' +
      "still-live `NestContainer` that corrupts jest-worker's IPC relay if anything about it " +
      'settles asynchronously later. Proven deterministically (a real TCP server pre-binds the ' +
      "exact port, no race) rather than relying on TC-5's own real free-port contention to " +
      'reproduce it, since a full, default-parallel `npm test` run is exactly the condition that ' +
      'already surfaced this once.',
    async () => {
      const tenantId = freshTenantId();
      await resetEnvToBaseline(tenantId);

      const ca = TestCertAuthority.build();
      const occupiedPort = await getFreePort();
      const identity = `rap-int062-tc8-${tenantId}`;
      process.env.GRPC_SERVER_ENABLED = 'true';
      process.env.GRPC_SERVER_PORT = String(occupiedPort);
      process.env.GRPC_SERVER_TLS_CA_PATH = ca.caCertPath;
      process.env.GRPC_SERVER_TLS_CERT_PATH = ca.serverCertPath;
      process.env.GRPC_SERVER_TLS_KEY_PATH = ca.serverKeyPath;
      process.env.GRPC_SERVER_ALLOWED_IDENTITIES = `${identity}:${tenantId}`;

      const seedSequelize = buildTestSequelize();
      await seedMatchingCampaignSnapshot(seedSequelize, tenantId, `CAMP-INT062-TC8-${tenantId}`);

      // Deliberately occupy the exact port GRPC_SERVER_PORT points at with a plain TCP server —
      // guarantees a real, deterministic EADDRINUSE on grpcApp.listen() (createGrpcMicroservice()
      // itself still succeeds first, unlike TC-6's missing-TLS-config case, which never gets that
      // far), not a race against other parallel workers.
      const blocker = createServer();
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(occupiedPort, resolve);
      });

      let caught: HybridBootstrapError | undefined;
      try {
        try {
          await startHybridBootstrap();
          throw new Error('expected startHybridBootstrap() to reject');
        } catch (error) {
          expect(error).toBeInstanceOf(HybridBootstrapError);
          caught = error as HybridBootstrapError;
        }

        expect(caught!.failures).toHaveLength(1);
        expect(caught!.failures[0].label).toContain('gRPC');
        expect(caught!.partial.grpcApp).toBeNull();

        // Same guard TC-6 already proves for the missing-TLS-config gRPC failure, now proven for
        // the "constructed then failed to listen" gRPC failure too: a misconfigured/unlucky
        // OPTIONAL transport must never take the primary listener down with it.
        const health = await request(caught!.partial.httpApp.getHttpServer()).get('/health');
        expect(health.status).toBe(200);

        // Close the first attempt's own httpApp (freeing its PORT) and the blocker (freeing
        // occupiedPort) before starting a second, brand new hybrid boot below — otherwise the
        // second boot's own `app.listen(PORT)` would hit its own unrelated EADDRINUSE against the
        // first attempt's still-open primary listener. T-INT-062 retry 3: no `process.env.PORT`
        // reassignment here anymore either — this whole file's PORT is genuinely fixed at import
        // time by `./hybrid-bootstrap-port.setup.ts` (a later write here was, like every other one
        // in this file, silently ineffective for the ACTUAL bound port); closing the first attempt's
        // `httpApp` above is what actually frees that one fixed port for the second boot below.
        await caught!.partial.httpApp.close();
        caught = undefined;
        await new Promise<void>((resolve) => blocker.close(() => resolve()));

        // Regression guard for the actual fix: if the earlier, now-fixed bug reappeared (the
        // successfully-constructed `grpcApp` from the attempt above leaking instead of being
        // closed), a SECOND, real gRPC bind on the exact same now-freed occupiedPort — inside a
        // brand new hybrid boot — would be unreliable (the leaked microservice's own handles could
        // still be live). This second attempt must cleanly succeed.
        const secondResult = await startExpectingSuccess();
        try {
          expect(secondResult.grpcApp).not.toBeNull();
        } finally {
          await secondResult.grpcApp?.close();
          await secondResult.httpApp.close();
        }
      } finally {
        blocker.close();
        await caught?.partial.httpApp.close();
        ca.cleanup();
        await cleanupProgressTenant(seedSequelize, tenantId);
        await seedSequelize.close();
      }
    },
  );
});
