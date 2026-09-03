/**
 * T-RAP-044. Sustained, mixed-transport (real mTLS gRPC + real Kafka) load test against the real
 * pipeline (`startInstance()`, reused unmodified from `full-pipeline-test-helpers.ts` — this
 * file's own header explains why), the real local Postgres 16 server and the real local Redpanda
 * broker — never mocked, per `AGENT-PROTOCOL.md` §3. See this task's own
 * `realtime-activity-processing-service-plan/reports/T-RAP-044-load-test-results.md` for the
 * numbers this file's own console output produced on a real run.
 *
 * TC-1: sustained mixed-transport ingestion across many distinct customers/campaigns, spot-checked
 * for zero duplicate/lost rows. TC-2 (numbers documented) is satisfied by this file's own
 * `console.log` output, captured verbatim into the results report. The progress-API-under-load
 * measurement (this task's own Scope "In": "progress-API response time under load") runs as this
 * same file's second `it()`, reusing the first `it()`'s own processed events rather than a
 * redundant separate ingestion pass — the two tests are intentionally NOT order-independent (Jest
 * runs one file's own `it()`s in declaration order by default); `allProcessedEvents` is populated
 * by the first and read by the second.
 *
 * Requires a running local Redpanda (`docker compose up -d redpanda`) and the real local Postgres
 * 16 server, already migrated (root `CLAUDE.md`) — same precondition every other `test/e2e/**` file
 * in this project already carries.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import type { Producer } from 'kafkajs';
import { ProgressApiRootModule } from '@/modules/progress-api/progress-api-server.main';
import { loadProgressApiAuthSecret } from '@/modules/progress-api/progress-api-token';
import {
  EncryptionService,
  loadEncryptionKeyMaterial,
} from '@/modules/encryption/encryption.service';
import {
  buildActivityIngestProducer,
  buildTestSequelize,
  cleanupTenant,
  READER_LEASE_ACQUIRE_TIMEOUT_MS,
  startInstance,
  startMockPortal,
  type Instance,
  type MockPortal,
} from '../full-pipeline-test-helpers';
import {
  buildLoadCampaigns,
  runMixedIngestStep,
  runProgressApiLoadStep,
  waitForDrainAndMeasure,
  type IngestStepResult,
  type SubmittedEvent,
} from './support/load-harness';

// This file's own single describe block runs five real-infra phases sequentially (the
// moderate/high/very-high/extreme ingestion steps, then the progress-API step) — generous
// headroom above `full-pipeline.e2e-spec.ts`'s own budget (which covers 4 TCs at a smaller scale)
// since this file's own steps intentionally submit more events per step. See that file's own
// comment for the full `READER_LEASE_ACQUIRE_TIMEOUT_MS` derivation this shares.
jest.setTimeout(READER_LEASE_ACQUIRE_TIMEOUT_MS + 300_000);

const AES_KEY_B64 = Buffer.alloc(32, 41).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 42).toString('base64');
const AUTH_SECRET_B64 = Buffer.alloc(32, 43).toString('base64');

const TENANT_ID = 900_000 + Math.floor(Math.random() * 40_000);
const CAMPAIGN_COUNT = 4;

describe('T-RAP-044 — sustained mixed-transport load (real gRPC + real Kafka + real processing/dispatch, real Postgres/Redpanda)', () => {
  let sequelize: Sequelize;
  let mockPortal: MockPortal;
  let producer: Producer;
  let progressApiApp: INestApplication;
  let instance: Instance;
  let encryption: EncryptionService;

  const allProcessedEvents: SubmittedEvent[] = [];
  const stepResults: Array<{
    step: IngestStepResult;
    drained: Awaited<ReturnType<typeof waitForDrainAndMeasure>>;
  }> = [];

  beforeAll(async () => {
    process.env.FIELD_ENCRYPTION_AES_KEY = AES_KEY_B64;
    process.env.FIELD_ENCRYPTION_HMAC_KEY = HMAC_KEY_B64;
    process.env.PROGRESS_API_AUTH_SECRET = AUTH_SECRET_B64;

    sequelize = buildTestSequelize();
    await sequelize.authenticate();
    mockPortal = await startMockPortal();
    producer = await buildActivityIngestProducer('t-rap-044-load-producer');

    const { payloads } = buildLoadCampaigns(TENANT_ID, CAMPAIGN_COUNT);
    mockPortal.setCampaigns(TENANT_ID, payloads);

    instance = await startInstance({
      tenantId: TENANT_ID,
      mockPortalPort: mockPortal.port,
      grpcIdentity: `t-rap-044-${TENANT_ID}`,
      aesKeyB64: AES_KEY_B64,
      hmacKeyB64: HMAC_KEY_B64,
    });

    const moduleRef = await Test.createTestingModule({
      imports: [ProgressApiRootModule],
    }).compile();
    progressApiApp = moduleRef.createNestApplication();
    await progressApiApp.init();
    // Explicitly bound to a real ephemeral port BEFORE the concurrent progress-API load step
    // fires — supertest's own `request(app)` lazily calls `app.listen(0)` the first time
    // `app.address()` is still null (`node_modules/supertest/lib/test.js`'s own
    // `serverAddress()`), and many concurrent `request(...)` calls issued before that first
    // `.listen()` resolves each independently see a still-null address and each try to `.listen()`
    // the SAME underlying `http.Server` a second (third, fourth, ...) time — a real race that
    // reproduced as `ECONNRESET` under this file's own concurrent burst the first time this file
    // was run against real infra. Listening once, up front, means every one of
    // `runProgressApiLoadStep`'s own concurrent `request(...)` calls sees an already-bound address
    // and never touches `.listen()` again.
    await progressApiApp.listen(0);

    encryption = new EncryptionService(loadEncryptionKeyMaterial());
  });

  afterAll(async () => {
    await instance.close();
    await progressApiApp.close();
    await cleanupTenant(sequelize, TENANT_ID);
    await producer.disconnect();
    await mockPortal.stop();
    await sequelize.close();
  });

  it(
    'TC-1: sustained mixed gRPC+Kafka ingestion across many distinct customers/campaigns — ' +
      'no duplicate/lost data, throughput and claim-to-processed latency documented',
    async () => {
      const { campaigns } = buildLoadCampaigns(TENANT_ID, CAMPAIGN_COUNT);

      // Four steps at increasing rate — an honest sustained-rate finding, not a pre-decided target
      // (`AGENT-PROTOCOL.md` §3 / this task's own implementation note 2). Per the real numbers in
      // this task's own results report: "moderate"/"high"/"very-high" (up to 100 events/sec
      // combined) all showed flat, poll-interval-dominated `claimToProcessedLatency` with zero
      // errors/unresolved rows; "extreme" (300 events/sec combined) is where a real degradation
      // signal actually appeared — `claimToProcessedLatency` roughly doubling — while STILL never
      // losing, duplicating, or erroring a single row (see this file's own assertions below, and
      // `T-RAP-044-load-test-results.md`'s own discussion of why this is a claim-worker
      // poll-interval/concurrency ceiling, not the advisory-lock contention `BACKLOG.md` B-1 asks
      // about).
      const ladder: Array<{ label: string; ratePerSec: number; durationSec: number }> = [
        { label: 'moderate', ratePerSec: 15, durationSec: 10 },
        { label: 'high', ratePerSec: 40, durationSec: 8 },
        { label: 'very-high', ratePerSec: 100, durationSec: 8 },
        { label: 'extreme', ratePerSec: 300, durationSec: 6 },
      ];
      for (const { label, ratePerSec, durationSec } of ladder) {
        const step = await runMixedIngestStep(
          instance,
          producer,
          campaigns,
          label,
          ratePerSec,
          durationSec,
          0.5,
        );
        const drained = await waitForDrainAndMeasure(
          sequelize,
          TENANT_ID,
          step.events.map((e) => e.eventId),
          Math.max(30_000, step.events.length * 150),
        );
        stepResults.push({ step, drained });
      }

      // TC-2 explicitly requires the actual numbers in the completion report; this is how they
      // get captured from a real run instead of invented.
      // eslint-disable-next-line no-console -- see comment above
      console.log(
        '[T-RAP-044 TC-1] ingestion + claim-to-processed steps:\n' +
          JSON.stringify(
            stepResults.map(({ step, drained }) => ({
              label: step.label,
              targetRatePerSec: step.targetRatePerSec,
              durationSec: step.durationSec,
              attempted: step.attempted,
              grpc: {
                succeeded: step.grpcSucceeded,
                failed: step.grpcFailed,
                latency: step.grpcLatency,
              },
              kafka: {
                acked: step.kafkaAcked,
                failed: step.kafkaFailed,
                ackLatency: step.kafkaAckLatency,
              },
              processedCount: drained.processedCount,
              errorCount: drained.errorCount,
              unresolvedCount: drained.unresolvedCount,
              claimToProcessedLatency: drained.claimToProcessedLatency,
            })),
            null,
            2,
          ),
      );

      // ---- Spot-check against real row counts — no duplicate, no lost data (TC-1's own DoD) ----
      for (const { step, drained } of stepResults) {
        expect(drained.errorCount).toBe(0);
        expect(drained.unresolvedCount).toBe(0);
        expect(drained.processedCount).toBe(step.events.length);

        const [{ activity_count: activityCount }] = await sequelize.query<{
          activity_count: string;
        }>(
          `SELECT COUNT(*) AS activity_count FROM realtime_activity_processing.activity_logs
             WHERE tenant_id = :tenantId AND dedup_key IN (:eventIds)`,
          {
            type: QueryTypes.SELECT,
            replacements: { tenantId: TENANT_ID, eventIds: step.events.map((e) => e.eventId) },
          },
        );
        // Exactly one fan-out row per submitted event — every campaign in this file's own fixture
        // set has a distinct `activityCode`, so each event matches exactly one campaign/component.
        expect(Number(activityCount)).toBe(step.events.length);

        // Every event in this file's own fixture carries a fresh, never-reused `customerId`
        // (`load-harness.ts`'s own `runMixedIngestStep`), so matching on `customer_id_hash` here
        // is exactly as precise as matching on `dedup_key` would be, and avoids needing a second
        // join back through `activity_logs` (`reward_entry` itself carries no `dedup_key` column —
        // `01-DATABASE.md` §7 — by design, since more than one fan-out row can share one activity).
        const customerHashes = step.events.map((e) => encryption.hash(e.customerId));
        const [{ reward_count: rewardCount }] = await sequelize.query<{ reward_count: string }>(
          `SELECT COUNT(*) AS reward_count FROM realtime_activity_processing.reward_entry
            WHERE tenant_id = :tenantId AND customer_id_hash IN (:customerHashes)`,
          {
            type: QueryTypes.SELECT,
            replacements: { tenantId: TENANT_ID, customerHashes },
          },
        );
        // One reward per processed activity (single-tracker, single-mandatory-component campaigns,
        // one fixed-amount reward each, caps never breached at this file's own scale).
        expect(Number(rewardCount)).toBe(step.events.length);

        allProcessedEvents.push(...step.events);
      }
    },
  );

  it('progress-API response time under load (this task\'s own Scope "In")', async () => {
    expect(allProcessedEvents.length).toBeGreaterThan(0); // depends on the previous `it()` — see header.

    // Bounded sample so this file's own total runtime stays reasonable — still a real concurrent
    // burst against the real HTTP/auth-guard/repository stack, not a single serialized loop.
    const sample = allProcessedEvents.slice(0, Math.min(allProcessedEvents.length, 200));
    const result = await runProgressApiLoadStep(
      progressApiApp,
      loadProgressApiAuthSecret(),
      TENANT_ID,
      sample,
      50,
    );

    // eslint-disable-next-line no-console -- TC-2's own "numbers documented" requirement.
    console.log(`[T-RAP-044 progress-API load] ${JSON.stringify(result, null, 2)}`);

    // Every sampled customer's tracker had already fully completed (same transaction as the
    // `activity_logs` row this file's own TC-1 already confirmed `processed`, per
    // `rule-evaluation-row-handler.service.ts`'s own single-transaction commit) — a real 200 with
    // `isCompleted: true` for every one is the actual, enforced outcome here, not a restated
    // constant.
    expect(result.failed).toBe(0);
    expect(result.succeeded).toBe(sample.length);
  });
});
