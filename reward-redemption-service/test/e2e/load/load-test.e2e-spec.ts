/**
 * T-RR-043 — sustained mixed-channel (real mTLS gRPC + real REST) load test against the real
 * pipeline: real `AppModule` REST ingestion, a real gRPC ingestion server, and — the part that
 * differs from every earlier `test/e2e/**` file this project has (all of which drive
 * `RedemptionProcessingOrchestrator.processClaimedEntry` by hand, one claimed row at a time,
 * exactly to avoid starting a real background `ClaimWorkerService` loop that would race other
 * suites' rows in the same un-tenant-scoped table) — `INSTANCE_COUNT` real, continuously-polling
 * `ClaimWorkerService` instances, each its own `RewardRedemptionEntryClaimRepository` +
 * `RedemptionProcessingOrchestrator` + its own `pg.Pool`, simulating `INSTANCE_COUNT` separately
 * running instances of this service all claiming from the one real shared Postgres table via
 * `FOR UPDATE SKIP LOCKED` — the actual mechanism `05-PROCESSING-PIPELINE.md` §8 says scales
 * close to linearly with instance count. This file's own job is to produce real numbers
 * confirming that reasoning holds for this schema/workload, not to invent a new throughput
 * mechanism (implementation note 1).
 *
 * **What's real vs. faked, and why (implementation note 3):** every ingestion transport, the real
 * claim SQL (`SKIP LOCKED` + advisory lock), the real state machine, and the real completion-sweep
 * transition to `completed` (including its own real `reward_tracking_dispatch_outbox` row write)
 * are the actual, unmodified production classes. Two boundaries are faked, both deliberately, both
 * matching this task's own instruction: (1) the portal-feed reward/connector-config resolution
 * (`RewardSystemResolutionService`/`ExternalRewardSystemConfigResolver`, faked identically to
 * `reward-entry.fixtures.ts`'s own `buildRealPipeline` for every other `test/e2e/**` file in this
 * project — out of this task's own scope, T-RR-022) always resolves every entry to
 * `CoreBankingConnector` — the *zero-I/O* stub this task's own implementation note 3 explicitly
 * sanctions as the "bulk of load-test traffic" choice, so the measured numbers characterize this
 * service's own pipeline, never a real network call to promo-code-service (which is not itself
 * under load test here); (2) `TenantSchemaConfigCache` (the portal-fed tenant/country lookup a
 * real `TenantSchemaEnrichmentService` reads through) is a fixed, single-row fake — the *real*
 * `TenantSchemaEnrichmentService` still runs and still performs a real
 * `UPDATE ... SET tenant_code, country_code ...` at claim time, closing the race a simple
 * pre-stamp-then-claim approach would have against this file's own continuously-running claim
 * workers (see `reward-entry.fixtures.ts`'s own `RealPipelineOptions.tenantSchemaEnrichment` doc
 * comment, this task's own additive change to that file).
 *
 * TC-1: sustained mixed gRPC+REST ingestion across many distinct campaigns/customers, zero
 * duplicate/lost rows, spot-checked against real row counts. TC-2/TC-3: throughput/latency numbers
 * and the honest 500-1000 RPS finding are both asserted-present via this file's own `console.log`
 * output (captured verbatim into this task's own completion report, mirroring
 * `T-RAP-044-load-test-results.md`'s own precedent) — no numeric target is hardcoded as a pass/fail
 * threshold here, per this task's own "report actual numbers, not pass/fail" instruction. TC-5: a
 * fraction of each step's own traffic deliberately resubmits an already-sent `id` via the opposite
 * channel, scheduled as the very next slot after the original (so it races real in-flight
 * processing, not a resend long after the original already settled) — R6 must hold under this
 * file's own real concurrent load, not just T-RR-041's low-concurrency e2e tests.
 *
 * Requires the real local Postgres 16 server, already migrated (root `CLAUDE.md`). Does not
 * require Redpanda — this file never calls `OutboxPublisherService.runOnce()` (the
 * `dispatched_external -> completed` transition's own outbox-row write happens synchronously
 * inside `CompletionSweepService.completeDispatched()`, not the separate outbox-publish worker —
 * see `05-PROCESSING-PIPELINE.md` §2's own table), so this task deliberately does not include Kafka
 * in its own scope: throughput/concurrency is this file's own subject, and T-RR-041 already proved
 * cross-channel parity (gRPC/Kafka/REST share one identical domain method) at low concurrency —
 * re-proving that identity under load would not exercise anything this file's own claim-worker/
 * advisory-lock scope doesn't already cover via gRPC+REST. Stated here plainly, per this task's own
 * "state which was actually done, honestly" instruction (Scope, implementation note 1).
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import { Test } from '@nestjs/testing';
import type { INestApplication, INestMicroservice } from '@nestjs/common';
import { Pool } from 'pg';
import { QueryTypes, type Sequelize } from 'sequelize';
import { createGrpcMicroservice } from '@/grpc/grpc-server.main';
import { AppModule } from '@/app.module';
import { ClaimWorkerService } from '@/modules/processing/claim-worker.service';
import { TenantSchemaEnrichmentService } from '@/modules/processing/reward-system-resolution.service';
import type { TenantSchemaConfigCache } from '@/modules/tenant-schema-cache/tenant-schema-config.cache';
import type { RewardRedemptionEntryClaimRepository } from '@/modules/processing/reward-redemption-entry-claim.repository';
import { TestCertAuthority, type IssuedCertificate } from '../../grpc/support/test-cert-authority';
import {
  createTestClient,
  type RewardIngestServiceTestClient,
} from '../../grpc/support/test-grpc-client';
import {
  buildClaimRepository,
  buildCoreBankingConnectorConfig,
  buildDbPool,
  buildRealPipeline,
  createMigrationDb,
  destroyRealPipeline,
  getFreePort,
  realDbConfigService,
  clearCoreBankingStubOutcome,
  setCoreBankingStubOutcome,
  acquireCrossFileClaimMutex,
  releaseCrossFileClaimMutex,
  type RealPipelineHandles,
} from '../fixtures/reward-entry.fixtures';
import {
  buildLoadCampaigns,
  cleanupLoadTestTenant,
  runMixedIngestStep,
  waitForDrainAndMeasure,
  type DrainResult,
  type IngestStepResult,
  type SendContext,
} from './load-test-scenarios';

// A generous ceiling for this file's own five sequential ladder steps (each: schedule+send, then
// drain-wait). See `full-pipeline.e2e-spec.ts`'s own identical precedent for why a real-infra e2e
// file needs headroom well above jest's 5s default.
jest.setTimeout(600_000);

const GRPC_IDENTITY = 'rr-e2e-load-test-client';
const TENANT_ID = 968_000 + Math.floor(Math.random() * 999);
const REST_TOKEN = process.env.REWARD_ENTRY_INGEST_TOKEN;
const CAMPAIGN_COUNT = 6;
/** Simulated concurrently-running instances of this service (this task's own Scope "In": "across
 * simulated multiple running instances of this service's process"). Each gets its own `pg.Pool`,
 * its own `RedemptionProcessingOrchestrator`, and its own `ClaimWorkerService` poll loop — the same
 * separation a real multi-instance deployment has, all claiming from the one real shared table. */
const INSTANCE_COUNT = 3;

interface SimulatedInstance {
  pool: Pool;
  pipeline: RealPipelineHandles;
  claimRepository: RewardRedemptionEntryClaimRepository;
  claimWorker: ClaimWorkerService;
}

function buildFakeTenantSchemaConfigCache(): TenantSchemaConfigCache {
  return {
    get: async () => [
      {
        id: 1,
        tenant_id: TENANT_ID,
        tenant_code: 'LOAD',
        country_code: 'US',
        environment: 'development',
        database_name: 'reward_system',
        schema_name: 'reward_redemption',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ],
  } as unknown as TenantSchemaConfigCache;
}

function buildSimulatedInstance(): SimulatedInstance {
  const pool = buildDbPool();
  const tenantSchemaEnrichment = new TenantSchemaEnrichmentService(
    realDbConfigService(),
    buildFakeTenantSchemaConfigCache(),
    pool,
  );
  const pipeline = buildRealPipeline({
    systemCode: 'CORE_BANKING',
    connectorConfig: buildCoreBankingConnectorConfig({ max_retry_attempts: 3 }),
    notificationsEnabled: false,
    sharedPool: pool,
    tenantSchemaEnrichment,
  });
  const claimRepository = buildClaimRepository(pool);
  const claimWorker = new ClaimWorkerService(
    claimRepository,
    { pollIntervalMs: 25, enabled: true },
    pipeline.orchestrator,
  );
  return { pool, pipeline, claimRepository, claimWorker };
}

describe('T-RR-043 — sustained load test (real gRPC + real REST + real Postgres, simulated multi-instance claim workers)', () => {
  let mutexClient: Awaited<ReturnType<typeof acquireCrossFileClaimMutex>>;
  let migrationDb: Sequelize;
  let ca: TestCertAuthority;
  let grpcApp: INestMicroservice;
  let grpcClient: RewardIngestServiceTestClient;
  let restApp: INestApplication;
  let campaigns: string[];
  let instances: SimulatedInstance[];

  beforeAll(async () => {
    if (!REST_TOKEN) {
      throw new Error('REWARD_ENTRY_INGEST_TOKEN is not set — see .env.local');
    }
    mutexClient = await acquireCrossFileClaimMutex();
    migrationDb = createMigrationDb();
    await migrationDb.authenticate();

    ca = TestCertAuthority.build();
    const grpcPort = await getFreePort();
    process.env.GRPC_SERVER_PORT = String(grpcPort);
    process.env.GRPC_SERVER_TLS_CA_PATH = ca.caCertPath;
    process.env.GRPC_SERVER_TLS_CERT_PATH = ca.serverCertPath;
    process.env.GRPC_SERVER_TLS_KEY_PATH = ca.serverKeyPath;
    process.env.GRPC_SERVER_ALLOWED_IDENTITIES = `${GRPC_IDENTITY}:${TENANT_ID}`;
    delete process.env.GRPC_SERVER_ENABLED;

    const maybeGrpcApp = await createGrpcMicroservice();
    if (maybeGrpcApp === null) {
      throw new Error('expected createGrpcMicroservice() to return a microservice in this test');
    }
    grpcApp = maybeGrpcApp;
    await grpcApp.listen();

    const clientCert: IssuedCertificate = ca.issueClientCert(GRPC_IDENTITY);
    const credentials = grpc.credentials.createSsl(
      readFileSync(ca.caCertPath),
      readFileSync(clientCert.keyPath),
      readFileSync(clientCert.certPath),
    );
    grpcClient = createTestClient(`localhost:${grpcPort}`, credentials);

    const restModuleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    restApp = restModuleRef.createNestApplication();
    await restApp.init();
    // T-RAP-044's own already-documented, already-reviewed fix for the identical root cause,
    // applied here: supertest's own `request(app)` lazily calls `app.listen(0)` the first time
    // `app.address()` is still null (`node_modules/supertest/lib/test.js`'s own `serverAddress()`)
    // — many concurrent `request(...)` calls issued before that first `.listen()` resolves each
    // independently see a still-null address and each try to `.listen()` the same underlying
    // `http.Server` again, racing each other (reproduced here as real `ECONNRESET`/`ECONNREFUSED`/
    // HTTP-parse errors under this file's own concurrent "high" rate-ladder step before this fix).
    // Listening once, up front, means every one of this file's own concurrent `request(...)` calls
    // sees an already-bound address and never touches `.listen()` again.
    await restApp.listen(0);

    campaigns = buildLoadCampaigns(TENANT_ID, CAMPAIGN_COUNT);
    for (const campaignCode of campaigns) {
      // eslint-disable-next-line no-await-in-loop -- a handful of one-shot setup writes, not a
      // throughput concern.
      await setCoreBankingStubOutcome(migrationDb, campaignCode, 'SUCCESS');
    }

    instances = Array.from({ length: INSTANCE_COUNT }, () => buildSimulatedInstance());
    for (const instance of instances) {
      instance.claimWorker.onApplicationBootstrap();
    }
  }, 300_000);

  /** Races `fn()` against a bounded timeout so one hanging teardown step (observed in this task's
   * own dev run: Node's `http.Server.close()` waits for every still-open keep-alive socket to
   * close on its own, and thousands of this file's own `supertest` REST calls across the rate
   * ladder can easily leave some open — `closeAllConnections()` below is this file's own primary
   * fix for that specific case) can never block every *other* teardown step, or this hook's own
   * overall timeout, indefinitely. Logs and moves on rather than failing the whole suite over a
   * best-effort cleanup step. */
  async function withTimeout(label: string, fn: () => Promise<void> | void): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve(fn()),
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`"${label}" exceeded its own 15s budget`)),
            15_000,
          );
        }),
      ]);
    } catch (error) {
      console.warn(`T-RR-043 load-test teardown step "${label}" failed:`, error);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  afterAll(async () => {
    for (const instance of instances ?? []) {
      // eslint-disable-next-line no-await-in-loop -- a handful of teardown calls; sequential is
      // simpler and this path is not itself under measurement.
      await withTimeout('claimWorker.onModuleDestroy', () =>
        instance.claimWorker.onModuleDestroy(),
      );
    }
    for (const instance of instances ?? []) {
      // eslint-disable-next-line no-await-in-loop -- see above.
      await withTimeout('destroyRealPipeline', () => destroyRealPipeline(instance.pipeline));
      // eslint-disable-next-line no-await-in-loop -- see above.
      await withTimeout('pool.end', () => instance.pool.end());
    }
    for (const campaignCode of campaigns ?? []) {
      // eslint-disable-next-line no-await-in-loop -- see above.
      await withTimeout('clearCoreBankingStubOutcome', () =>
        clearCoreBankingStubOutcome(migrationDb, campaignCode),
      );
    }
    if (migrationDb) {
      await withTimeout('cleanupLoadTestTenant', () =>
        cleanupLoadTestTenant(migrationDb, TENANT_ID),
      );
    }
    const steps: Array<{ label: string; run: () => Promise<void> | void }> = [
      { label: 'grpcClient.close', run: () => grpcClient?.close() },
      { label: 'grpcApp.close', run: () => grpcApp?.close() },
      {
        label: 'restApp.close',
        run: () => {
          // Force-close any still-open keep-alive sockets left by this file's own many
          // `supertest` REST calls first — `closeAllConnections()` (Node 18.2+) is what actually
          // makes the following `close()` resolve promptly instead of waiting for every socket to
          // close on its own (this task's own dev-run finding, see this function's own header).
          const httpServer = restApp?.getHttpServer() as
            { closeAllConnections?: () => void } | undefined;
          httpServer?.closeAllConnections?.();
          return restApp?.close();
        },
      },
      { label: 'migrationDb.close', run: () => migrationDb?.close() },
      { label: 'ca.cleanup', run: () => ca?.cleanup() },
    ];
    for (const step of steps) {
      // eslint-disable-next-line no-await-in-loop -- fixed, short teardown sequence.
      await withTimeout(step.label, step.run);
    }
    if (mutexClient) {
      await releaseCrossFileClaimMutex(mutexClient);
    }
  }, 180_000);

  it(
    'TC-1/TC-2/TC-3/TC-5: sustained mixed gRPC+REST ingestion across a rate ladder — zero ' +
      'duplicate/lost rows (incl. under deliberate same-id resends), throughput/latency numbers ' +
      'documented, 500-1000 RPS finding reported honestly',
    async () => {
      const ctx: SendContext = { grpcClient, restApp, restToken: REST_TOKEN as string };

      // An honest sustained-rate finding, not a rate chosen to guarantee a pass (this task's own
      // implementation note 2 / "report actual numbers, not pass/fail"). Combined (gRPC+REST)
      // target rates climb toward, and past, the 500-1000 RPS band requirement #3 names.
      // `duplicateFraction` folds TC-5's own deliberate same-id resends into the same schedule as
      // the throughput measurement itself, rather than as a separate, lower-concurrency pass.
      const ladder: Array<{
        label: string;
        ratePerSec: number;
        durationSec: number;
        duplicateFraction: number;
      }> = [
        { label: 'moderate', ratePerSec: 50, durationSec: 5, duplicateFraction: 0.1 },
        { label: 'high', ratePerSec: 150, durationSec: 5, duplicateFraction: 0.1 },
        { label: 'very-high', ratePerSec: 400, durationSec: 4, duplicateFraction: 0.1 },
        { label: 'extreme', ratePerSec: 800, durationSec: 3, duplicateFraction: 0.1 },
        // Deliberately double `05-PROCESSING-PIPELINE.md` §8's own 500-1000 RPS band's own upper
        // bound — this task's own instruction to report "whatever ceiling (if any) appears as
        // concurrency increases" is best answered by pushing past the required band, not stopping
        // exactly at it. See this task's own completion report for the real degradation signal
        // this step surfaces (claim-to-dispatched-external latency, not an error/data-loss ceiling).
        { label: 'beyond-target', ratePerSec: 1600, durationSec: 3, duplicateFraction: 0.1 },
      ];

      const results: Array<{ step: IngestStepResult; drained: DrainResult }> = [];

      for (const { label, ratePerSec, durationSec, duplicateFraction } of ladder) {
        const stepStartedAt = Date.now();
        // eslint-disable-next-line no-await-in-loop -- the whole point is one ladder step at a
        // time, back to back, in the same long-lived real instance (mirrors T-RAP-044's own
        // sequential-steps design).
        const step = await runMixedIngestStep(
          ctx,
          TENANT_ID,
          campaigns,
          label,
          ratePerSec,
          durationSec,
          duplicateFraction,
        );
        const actualElapsedSec = (Date.now() - stepStartedAt) / 1000;
        const ids = step.uniqueFixtures.map((f) => f.id);
        // eslint-disable-next-line no-await-in-loop -- see above.
        const drained = await waitForDrainAndMeasure(
          migrationDb,
          instances[0].pipeline.completionSweep,
          TENANT_ID,
          ids,
          Math.max(30_000, ids.length * 100),
        );
        results.push({ step, drained });

        // TC-2/TC-3: the actual numbers, captured verbatim into this task's own completion report.
        // eslint-disable-next-line no-console -- see comment above.
        console.log(
          `[T-RR-043 ${label}] combined achieved rate: ${(step.attempted / actualElapsedSec).toFixed(1)} req/s ` +
            `(target ${ratePerSec}/s over ${durationSec}s, actually took ${actualElapsedSec.toFixed(2)}s)\n` +
            JSON.stringify(
              {
                label,
                targetRatePerSec: ratePerSec,
                durationSec,
                attempted: step.attempted,
                duplicateSlots: step.duplicateSlots,
                rest: {
                  succeeded: step.restSucceeded,
                  failed: step.restFailed,
                  latency: step.restLatency,
                },
                grpc: {
                  succeeded: step.grpcSucceeded,
                  failed: step.grpcFailed,
                  latency: step.grpcLatency,
                },
                errorsSample: step.errors.slice(0, 5),
                uniqueSubmitted: ids.length,
                completedCount: drained.completedCount,
                failedCount: drained.failedCount,
                unresolvedCount: drained.unresolvedCount,
                claimToDispatchedExternalLatency: drained.claimToDispatchedExternalLatency,
                claimToCompletedLatency: drained.claimToCompletedLatency,
              },
              null,
              2,
            ),
        );

        // ---- TC-1's own DoD: no duplicate/lost row, cross-checked against real counts ----
        expect(step.restFailed).toBe(0);
        expect(step.grpcFailed).toBe(0);
        expect(drained.failedCount).toBe(0);
        expect(drained.unresolvedCount).toBe(0);

        // eslint-disable-next-line no-await-in-loop -- see above.
        const [{ entry_count: entryCount }] = await migrationDb.query<{ entry_count: string }>(
          `SELECT count(*)::text AS entry_count
             FROM reward_redemption.reward_redemption_entry
            WHERE tenant_id = :tenantId AND id IN (:ids)`,
          { type: QueryTypes.SELECT, replacements: { tenantId: TENANT_ID, ids } },
        );
        // Exactly one row per unique id, however many times (including 0) a duplicate resend for
        // that id was scheduled — R6 holding under this file's own real concurrent load, not just
        // T-RR-041's low-concurrency e2e tests (TC-5).
        expect(Number(entryCount)).toBe(ids.length);

        // eslint-disable-next-line no-await-in-loop -- see above.
        const callLogRows = await migrationDb.query<{
          reward_entry_id: string;
          call_count: string;
        }>(
          `SELECT reward_entry_id, count(*)::text AS call_count
             FROM reward_redemption.external_system_call_log
            WHERE reward_entry_id IN (:ids)
            GROUP BY reward_entry_id`,
          { type: QueryTypes.SELECT, replacements: { ids } },
        );
        // Every id has exactly one connector call logged — a duplicate arrival (TC-5) must never
        // cause a second, redundant call to the external system, even when it raced real,
        // concurrent claim-worker processing rather than arriving after the row had already
        // settled.
        expect(callLogRows).toHaveLength(ids.length);
        expect(callLogRows.every((r) => Number(r.call_count) === 1)).toBe(true);
      }

      // Requirement #3's own honest finding, reported rather than asserted as pass/fail (this
      // task's own implementation note 4) — the full per-step achieved-rate/latency numbers are
      // already in the console output above; this final line is only a pointer for whoever reads
      // this file's own captured output (or this task's own completion report) next.
      const peak = results[results.length - 1];
      // eslint-disable-next-line no-console -- TC-3's own "documented honestly either way" requirement.
      console.log(
        `[T-RR-043] summary: ${results.length} ladder steps run, "${peak.step.label}" the highest ` +
          `(targeted ${peak.step.targetRatePerSec} combined req/s). Zero errors/unresolved/lost/` +
          "duplicated rows at every step tested — see each step's own line above for the actual " +
          "achieved rate and claim-to-completed latency, and this task's own completion report for " +
          'the honest 500-1000 RPS finding and limiting factor, if any.',
      );
    },
  );
});
