/**
 * T-INT-043. Real, live proof that the processing/dispatch worker bundle
 * (`ProcessingModule` + `DispatchModule`) actually runs once wired into `src/main.ts`'s hybrid
 * bootstrap behind `PROCESSING_ENABLED` — the exact gap T-INT-040 discovered live (see this task's
 * own "Evidence" section, `reward-service-integration-plan/tasks/
 * T-INT-043-rap-processing-dispatch-never-wired-into-any-live-process.md`): a real, matched
 * `pending` `activity_logs` row sat forever because no real process anywhere ever constructed
 * `ProcessingModule`/`DispatchModule`. Every scenario below calls the exact same
 * `startHybridBootstrap()` export `src/main.ts`'s own real deployed process uses — no test-only
 * bootstrap substituted for it (`AGENT-PROTOCOL.md` §3's "assert the observable property").
 *
 * Real local Postgres 16 (root `CLAUDE.md`), a real mock portal gRPC server (same
 * `startMockPortal()` helper `test/e2e/full-pipeline*.e2e-spec.ts` already established and proved
 * against, reused here rather than re-implemented), and — for TC-1's own dispatch-tier assertion —
 * the real `reward_dispatch_channel_config` GLOBAL row every local/Render environment already has
 * migrated (`primary_channel='REST'`, `fallback_channel='KAFKA'`, migration 017): nothing listens
 * on `REWARD_REDEMPTION_REST_BASE_URL` in this test environment, so the REST attempt fails fast and
 * the row falls back to Kafka after `REWARD_DISPATCH_MAX_RETRY_ATTEMPTS` (default 8) poll cycles —
 * the exact same channel-resolution path `test/e2e/full-pipeline.e2e-spec.ts`'s own TC-7 already
 * relies on for its own "Stage 5" Kafka-dispatch assertion, reused here rather than re-derived.
 * `dispatch_status='dispatched'` (asserted below, not a specific channel) is deliberately the
 * channel-agnostic, robust signal for "dispatch actually succeeded" — true regardless of whether
 * REST or Kafka happened to carry it in a given run.
 *
 * This file does **not** re-prove rule-evaluation/cap-enforcement/dispatch-channel-resolution edge
 * cases already covered by `test/processing/**`/`test/budget/**`/`test/dispatch/**` unit specs and
 * `test/e2e/full-pipeline*.e2e-spec.ts` — its own job is narrower and specific to this task: proving
 * the bundle is reachable AT ALL from a real process, gated correctly, without disturbing Render's
 * existing unconfigured deploy.
 *
 * **T-INT-043 retry 1 — real, cross-process worker-bundle serialization added.** An independent
 * review of a full, unfiltered `npm test` run (5x) found this file's own TC-1 — the one scenario
 * below that actually constructs a real `ProcessingModule` (`ActivityLogClaimWorker`, globally
 * scoped, claims ANY `pending` row in the whole shared `activity_logs` table, not filtered by
 * tenant — same fact `full-pipeline.e2e-spec.ts`'s own header and
 * `kafka-shared-consumer-group-lock.ts`'s own header already document) — was a second, previously
 * un-coordinated real instance of that same globally-scoped hazard. `full-pipeline*.e2e-spec.ts`'s
 * own worker bundle already only ever runs while holding
 * `kafka-shared-consumer-group-lock.ts`'s real, cross-process mutual-exclusion lock (via
 * `full-pipeline-test-helpers.ts`'s own `startInstance()`/`close()`) specifically so no two files'
 * own real claim workers can ever run concurrently against the same shared table — this file's
 * first draft never joined that same lock, so under a full parallel `npm test` run it could (and,
 * per that review, did) race a DIFFERENT file's own one-off `claimNextPendingRow()` call
 * (`test/modules/processing/rule-evaluation.spec.ts`'s own T-RAP-059 case) for a row that test had
 * just inserted itself, and it added a second concurrently-running heavy real-infra bundle (real
 * Postgres connections, a real Kafka producer/consumer) on top of whatever `full-pipeline*` files
 * were already doing at the same moment, worsening unrelated resource contention elsewhere in the
 * suite (that same review's other two reproductions: `full-pipeline.e2e-spec.ts` TC-7 "socket hang
 * up", and one jest-worker crash). TC-1 below now acquires the exact same real lease
 * (`acquireIngestConsumerGroupReaderLease`) `startInstance()` already uses, for the same
 * construct-to-close span, so at most one real globally-scoped claim-worker bundle runs anywhere in
 * the whole suite at a time — the actual, established discipline this project already has for this
 * exact hazard, not a new one invented here. TC-2/TC-3 construct no such worker (`PROCESSING_ENABLED`
 * is left unset in both) and so need no lease.
 */
import './processing-worker-port.setup';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import request from 'supertest';
import { startHybridBootstrap, HybridBootstrapError, type HybridBootstrapResult } from '@/main';
import { OutboxPublisherService } from '@/modules/dispatch/outbox-publisher.service';
import { ActivityLogClaimWorker } from '@/modules/processing/activity-log-claim.worker';
import {
  EncryptionService,
  loadEncryptionKeyMaterial,
} from '@/modules/encryption/encryption.service';
import {
  acquireIngestConsumerGroupReaderLease,
  type IngestConsumerGroupReaderLease,
} from '../e2e/kafka-shared-consumer-group-lock';
import {
  buildCampaign,
  buildComponentReward,
  buildTestSequelize,
  cleanupTenant,
  READER_LEASE_ACQUIRE_TIMEOUT_MS,
  startMockPortal,
  waitUntil,
  type MockPortal,
} from '../e2e/full-pipeline-test-helpers';

// T-INT-043 retry 1: same convention every other file that acquires
// `acquireIngestConsumerGroupReaderLease` already follows (`full-pipeline.e2e-spec.ts`,
// `full-pipeline-multi-instance.e2e-spec.ts`) — this file's own `jest.setTimeout` must bake in the
// full acquire-wait budget on top of its own real work (TC-1's own two `waitUntil` polls, 90s + 90s
// = 180s worst case, plus Nest/DB/mock-portal boot overhead), not just the real-work time alone, or
// a legitimately-queued wait behind another file's own lock hold would blow this file's timeout
// before the lock module's own clearer, attributable timeout error ever got a chance to fire.
jest.setTimeout(READER_LEASE_ACQUIRE_TIMEOUT_MS + 240_000);

const AES_KEY_B64 = Buffer.alloc(32, 41).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 42).toString('base64');

let nextTenantId = 990_000 + Math.floor(Math.random() * 9_000);
function freshTenantId(): number {
  nextTenantId += 1;
  return nextTenantId;
}

/**
 * Same "never leak the primary HTTP app on an unexpected throw" discipline
 * `test/main/hybrid-bootstrap.e2e-spec.ts`'s own `startExpectingSuccess()` already established
 * (not imported from there — that helper is local/unexported in that file, same convention this
 * file follows for its own copy rather than widening that file's own exports for one new caller).
 */
async function startExpectingSuccess(): Promise<HybridBootstrapResult> {
  try {
    return await startHybridBootstrap();
  } catch (error) {
    if (error instanceof HybridBootstrapError) {
      await error.partial.httpApp.close().catch(() => {});
    }
    throw error;
  }
}

/** Every one of this file's own hybrid gates unset (= disabled) by default; each test flips on
 * only the ones it exercises — same baseline-reset convention `hybrid-bootstrap.e2e-spec.ts`'s own
 * `resetEnvToBaseline` already established for this project. */
async function resetEnvToBaseline(): Promise<void> {
  delete process.env.GRPC_SERVER_ENABLED;
  delete process.env.ACTIVITY_INGEST_CONSUMER_ENABLED;
  delete process.env.PROGRESS_API_ENABLED;
  delete process.env.PROCESSING_ENABLED;

  process.env.FIELD_ENCRYPTION_AES_KEY = AES_KEY_B64;
  process.env.FIELD_ENCRYPTION_HMAC_KEY = HMAC_KEY_B64;
  // DispatchModule's RewardRestFallbackClient factory (dispatch.module.ts) reads this eagerly at DI
  // construction time regardless of which channel actually ends up selected for a given row — see
  // .env.example's own PROCESSING_ENABLED note. A throwaway value only satisfies that constructor;
  // nothing in this file expects a real reward-redemption-service listening on the REST base URL.
  process.env.REWARD_REDEMPTION_REST_TOKEN = 't-int-043-throwaway-token';

  // PORT is deliberately NOT set here — see `./processing-worker-port.setup.ts`'s own header for
  // why a per-test override of this one specific field is silently ineffective (a real,
  // pre-existing `@nestjs/config` quirk, not something this function can work around itself).
}

async function pointAtMockPortal(tenantId: number, mockPortalPort: number): Promise<void> {
  process.env.PORTAL_CONFIG_TENANT_IDS = String(tenantId);
  process.env.PORTAL_GRPC_HOST = '127.0.0.1';
  process.env.PORTAL_GRPC_PORT = String(mockPortalPort);
  process.env.PORTAL_GRPC_TIMEOUT_MS = '5000';
  delete process.env.PORTAL_GRPC_TLS_CA_PATH;
  delete process.env.PORTAL_GRPC_TLS_CERT_PATH;
  delete process.env.PORTAL_GRPC_TLS_KEY_PATH;
}

interface PendingRowArgs {
  tenantId: number;
  customerId: string;
  campaignCode: string;
  trackerCode: string;
  trackerComponentCode: string;
  dedupKey: string;
}

/**
 * Directly inserts a `pending` `activity_logs` row with already-resolved campaign/tracker/component
 * codes — this is the exact row shape T-INT-040's own "Evidence" section captured live via a real
 * gRPC ingest (`campaign_code=WELCOME_STREAK_LIVE, tracker_code=TRK-530457-OQIDT5,
 * tracker_component_code=CMP-530457-JHISLD`, `status='pending'` forever). Inserting it directly here
 * (rather than re-running a full gRPC/Kafka ingest, already proven end to end by T-INT-003's own
 * suite and `test/e2e/full-pipeline*.e2e-spec.ts`) isolates this file's own job — proving
 * `ProcessingModule`/`DispatchModule` are reachable from a real process — from ingestion/mapping,
 * which this task's own Scope explicitly does not touch.
 */
async function insertPendingActivityLogRow(
  sequelize: Sequelize,
  encryption: EncryptionService,
  args: PendingRowArgs,
): Promise<string> {
  const id = randomUUID();
  await sequelize.query(
    `INSERT INTO realtime_activity_processing.activity_logs
       (id, correlation_id, dedup_key, tenant_id, customer_id_encrypted, customer_id_hash,
        customer_id_type, activity_performed_date, activity_type, activity_category,
        activity_value, activity_value_unit, channel, activity_performed_env, activity_name,
        campaign_code, tracker_code, tracker_component_code, source_transport, status)
     VALUES
       (:id, :correlationId, :dedupKey, :tenantId, :customerIdEncrypted, :customerIdHash,
        'INTERNAL_ID', now(), 'TRANSACTION', 'RETAIL',
        100.0000, 'MYR', 'WEB', 'PROD', 'T-INT-043 e2e activity',
        :campaignCode, :trackerCode, :trackerComponentCode, 'GRPC', 'pending')`,
    {
      type: QueryTypes.RAW,
      replacements: {
        id,
        correlationId: randomUUID(),
        dedupKey: args.dedupKey,
        tenantId: args.tenantId,
        customerIdEncrypted: encryption.encrypt(args.customerId),
        customerIdHash: encryption.hash(args.customerId),
        campaignCode: args.campaignCode,
        trackerCode: args.trackerCode,
        trackerComponentCode: args.trackerComponentCode,
      },
    },
  );
  return id;
}

async function fetchActivityLogRow(
  sequelize: Sequelize,
  id: string,
): Promise<{ status: string; comment: string | null } | undefined> {
  const [row] = await sequelize.query<{ status: string; comment: string | null }>(
    `SELECT status, comment FROM realtime_activity_processing.activity_logs WHERE id = :id`,
    { type: QueryTypes.SELECT, replacements: { id } },
  );
  return row;
}

async function fetchRewardEntries(
  sequelize: Sequelize,
  tenantId: number,
  campaignCode: string,
): Promise<Array<{ id: string; customer_id_hash: string; dispatch_status: string }>> {
  return sequelize.query(
    `SELECT id, customer_id_hash, dispatch_status
       FROM realtime_activity_processing.reward_entry
      WHERE tenant_id = :tenantId AND campaign_code = :campaignCode`,
    { type: QueryTypes.SELECT, replacements: { tenantId, campaignCode } },
  );
}

describe('T-INT-043 — processing/dispatch worker bundle wired into the hybrid bootstrap (e2e, real Postgres, real mock portal)', () => {
  let sequelize: Sequelize;
  let mockPortal: MockPortal;
  let encryption: EncryptionService;
  const usedTenantIds: number[] = [];

  beforeAll(async () => {
    process.env.FIELD_ENCRYPTION_AES_KEY = AES_KEY_B64;
    process.env.FIELD_ENCRYPTION_HMAC_KEY = HMAC_KEY_B64;
    sequelize = buildTestSequelize();
    await sequelize.authenticate();
    mockPortal = await startMockPortal();
    encryption = new EncryptionService(loadEncryptionKeyMaterial());
  });

  afterAll(async () => {
    for (const tenantId of usedTenantIds) {
      await cleanupTenant(sequelize, tenantId);
    }
    await mockPortal.stop();
    await sequelize.close();
  });

  function reserveTenant(): number {
    const tenantId = freshTenantId();
    usedTenantIds.push(tenantId);
    return tenantId;
  }

  // TC-1
  it(
    'TC-1: PROCESSING_ENABLED=true claims and processes a real pending activity_logs row through ' +
      'to reward_entry creation AND dispatch, inside the hybrid process',
    async () => {
      await resetEnvToBaseline();
      const tenantId = reserveTenant();
      const { payload } = buildCampaign({
        tenantId,
        campaignCode: `CAMP-INT043-TC1-${tenantId}`,
        rewards: [buildComponentReward(tenantId * 100 + 2)],
      });
      mockPortal.setCampaigns(tenantId, [payload]);
      await pointAtMockPortal(tenantId, mockPortal.port);
      process.env.PROCESSING_ENABLED = 'true';

      const customerId = `cust-int043-tc1-${randomUUID()}`;
      const dedupKey = `evt-int043-tc1-${randomUUID()}`;
      const campaignCode = payload.campaignCode;
      const trackerCode = payload.trackers[0].trackerCode;
      const componentCode = payload.trackers[0].components[0].componentCode;

      // T-INT-043 retry 1: exclusive, cross-process access to the one real, globally-scoped
      // ActivityLogClaimWorker slot this suite allows at a time — see this file's own header for
      // why. **Acquired BEFORE this test's own row is inserted, not after** (this file's own first
      // draft, and this same retry's own first attempt, both inserted the row first) — re-
      // verification under a real, genuinely contended full-suite `npm test` run caught the actual
      // defect that ordering has: while this call is genuinely QUEUED (another file's own worker
      // bundle, e.g. `full-pipeline*.e2e-spec.ts`, currently holds the lock), that OTHER file's own
      // real, globally-scoped worker is still actively running and claiming ANY pending row from the
      // whole shared `activity_logs` table — so a row inserted before this line is fully exposed,
      // for however long this call ends up queued, to being claimed by that unrelated holder, whose
      // own cache has no entry for this test's own tenant/campaign
      // (`RuleEvaluationRowHandler.resolveTrackerContext` throws "No cached campaign config..."),
      // leaving it stuck `'processing'` until `DEFAULT_STALE_TIMEOUT_SECONDS` (300s) — reproduced
      // directly: a captured full-suite run's own structured log showed exactly this
      // (`ActivityLogClaimWorker`: `"ActivityLogRowHandler threw for row ... (left 'processing' for
      // the stale sweep): No cached campaign config for tenant ... campaign
      // \"CAMP-INT043-TC1-...\""`), timestamped roughly a second after this test's own insert and
      // well before this test's own worker had even started — that gap is exactly this ordering
      // defect. Acquiring first closes it: by the time this test's own row becomes visible at all,
      // no OTHER worker-bundle holder can be active, and this test's OWN worker (started
      // immediately after, below) is the very next thing to run.
      const readerLease: IngestConsumerGroupReaderLease =
        await acquireIngestConsumerGroupReaderLease(READER_LEASE_ACQUIRE_TIMEOUT_MS);

      let result: HybridBootstrapResult | undefined;
      // Definite-assignment (`!`), not `| undefined`: always assigned as the very first statement
      // in the `try` block below, before any `await` yields control elsewhere — never actually read
      // in an unassigned state. Kept as a plain `string` (not `string | undefined`) specifically so
      // the `waitUntil(...)` closure a few lines down, which TypeScript cannot narrow across a
      // closure boundary for a mutable `let`, still type-checks without a redundant runtime guard.
      let rowId!: string;
      try {
        rowId = await insertPendingActivityLogRow(sequelize, encryption, {
          tenantId,
          customerId,
          campaignCode,
          trackerCode,
          trackerComponentCode: componentCode,
          dedupKey,
        });

        result = await startExpectingSuccess();

        // The one property this whole task exists to prove: constructing the hybrid process with
        // PROCESSING_ENABLED=true actually gives you a real, non-null processing/dispatch context —
        // T-INT-040's own evidence is exactly "no real process anywhere ever did this".
        expect(result.processingWorkerContext).not.toBeNull();
        expect(result.grpcApp).toBeNull();
        expect(result.ingestConsumerContext).toBeNull();
        expect(result.progressApiApp).toBeNull();

        // ActivityLogClaimWorker/StaleProcessingSweepService both autostart unconditionally
        // (`src/main.ts`'s own header) — no explicit start() call needed for the claim itself.
        //
        // T-INT-043 retry 1: waits for the actual terminal state (`'processed'`), not merely
        // "left `'pending'`" — the previous version's `status !== 'pending'` polling condition was
        // satisfied the instant ANY claim happened and then asserted `'processed'` immediately
        // after, with no headroom for the row to still legitimately be mid-pipeline
        // (`'processing'`) under real contention. This file's own earlier 30_000 budget was raised
        // to 60_000 first (matching `full-pipeline.e2e-spec.ts`'s own tuned precedent for the
        // identical claim-to-`'processed'` transition) and then to 90_000, matching
        // `full-pipeline-multi-instance.e2e-spec.ts`'s own even more generous precedent for the
        // same step — re-verification under real, genuinely contended full-suite `npm test` runs
        // (many concurrent heavy real-Postgres/gRPC/Kafka e2e suites, exactly the condition every
        // one of these constants was independently tuned against) showed 60_000 alone still timing
        // out under worse-than-typical ambient load; 90_000 is the most generous value already
        // established anywhere in this codebase for this exact kind of step, not a new, unvetted
        // number. This file's own dispatch-status wait below keeps its original 30_000, matching
        // `full-pipeline.e2e-spec.ts`'s own 30_000 precedent for the (cheaper, already-`'processed'`-
        // row) dispatch step specifically.
        await waitUntil(async () => {
          const row = await fetchActivityLogRow(sequelize, rowId);
          return row?.status === 'processed';
        }, 90_000);

        const row = await fetchActivityLogRow(sequelize, rowId);
        expect(row?.status).toBe('processed');

        const rewards = await fetchRewardEntries(sequelize, tenantId, campaignCode);
        expect(rewards).toHaveLength(1);
        expect(rewards[0].customer_id_hash).toBe(encryption.hash(customerId));

        // T-INT-043 retry 1: this test's own job (proving the claim happened at all) is done the
        // instant the row above reached `'processed'` — every further second this real, globally-
        // scoped `ActivityLogClaimWorker`'s 4 lanes (`DEFAULT_CLAIM_CONCURRENCY`) keep polling is
        // pure, unnecessary extra load on the one real, shared `activity_logs` table every other
        // concurrently-running suite's own bounded give-back retry budget (`claim-worker.spec.ts`,
        // `cap-enforcement.spec.ts`, `tracker-completion.spec.ts` — none of which hold this file's
        // own reader lease, since that lock only ever coordinated the OTHER "worker bundle" class of
        // caller, `full-pipeline*.e2e-spec.ts`) was tuned against. `stop()` is the same real,
        // public, idempotent method `ActivityLogClaimWorker.onModuleDestroy()` itself calls — used
        // here directly, ahead of the full `processingWorkerContext.close()` still in this test's
        // own `finally` below, purely to shrink this worker's own real-claiming *window*, not to
        // fake or skip anything this task's own DoD requires (`OutboxPublisherService`, resolved
        // from this exact same context two lines below, is untouched and keeps running).
        result.processingWorkerContext!.get(ActivityLogClaimWorker).stop();

        // OutboxPublisherService/RewardDispatchRetryWorker's own autostart is gated OFF under
        // NODE_ENV=test (dispatch.module.ts's own OUTBOX_PUBLISHER_AUTOSTART factory) — the exact
        // same reason test/e2e/full-pipeline-test-helpers.ts's own WorkerRootModule harness calls
        // .start() explicitly too (its own header). Outside a test process (NODE_ENV!=='test') this
        // starts on its own the instant the context is constructed, with no extra call needed — see
        // src/main.ts's own createProcessingWorkerContext() header. Retrieving the REAL provider
        // this task's own hybrid context actually wires (not a second, separately-constructed
        // instance) is itself part of what this test proves.
        result.processingWorkerContext!.get(OutboxPublisherService).start();

        // T-INT-043 retry 1: raised from this file's own earlier 30_000 (matching
        // `full-pipeline.e2e-spec.ts`'s own precedent for this same dispatch-status step) to
        // 60_000, then to 90_000 (matching the claim-to-`'processed'` wait above) — re-verification
        // under real full-suite contention showed the REST-fails-fast/Kafka-fallback round trip (8
        // retry attempts, exponential backoff, `dispatch.config.ts`'s own
        // `DEFAULT_REWARD_DISPATCH_MAX_RETRY_ATTEMPTS`/`DEFAULT_RETRY_BACKOFF_BASE_MS`) occasionally
        // exceeding even 60s once real Postgres/Kafka round trips are themselves slower under a
        // genuinely heavily-loaded full-suite run — the same class of headroom problem the claim-
        // to-`'processed'` wait above already needed more of. Matching that same wait's own 90_000
        // ceiling keeps this file internally consistent rather than inventing a third distinct
        // budget for what is, under contention, the same underlying "real DB/broker round trip
        // competing with ~74 other suites" problem.
        await waitUntil(async () => {
          const entries = await fetchRewardEntries(sequelize, tenantId, campaignCode);
          return entries[0]?.dispatch_status === 'dispatched';
        }, 90_000);
      } finally {
        try {
          await result?.processingWorkerContext?.close();
          await result?.httpApp.close();
        } finally {
          readerLease.release();
        }
      }
    },
  );

  // TC-2
  it(
    'TC-2: PROCESSING_ENABLED left unset (default off) — same off-by-default convention as every ' +
      'other hybrid gate; the row is never claimed',
    async () => {
      await resetEnvToBaseline();
      const tenantId = reserveTenant();
      const { payload } = buildCampaign({
        tenantId,
        campaignCode: `CAMP-INT043-TC2-${tenantId}`,
        rewards: [buildComponentReward(tenantId * 100 + 2)],
      });
      mockPortal.setCampaigns(tenantId, [payload]);
      // PROCESSING_ENABLED intentionally left unset — this is the "default off" case.

      const rowId = await insertPendingActivityLogRow(sequelize, encryption, {
        tenantId,
        customerId: `cust-int043-tc2-${randomUUID()}`,
        campaignCode: payload.campaignCode,
        trackerCode: payload.trackers[0].trackerCode,
        trackerComponentCode: payload.trackers[0].components[0].componentCode,
        dedupKey: `evt-int043-tc2-${randomUUID()}`,
      });

      let result: HybridBootstrapResult | undefined;
      try {
        result = await startExpectingSuccess();
        // The deterministic property this test exists to prove: no worker context is constructed
        // in THIS process at all when the gate is off.
        expect(result.processingWorkerContext).toBeNull();

        // Secondary, best-effort corroboration on the row itself — deliberately tolerant of the
        // same pre-existing, already-documented cross-file hazard `test/e2e/full-pipeline.e2e-spec.ts`'s
        // own header discloses ("the same accepted, already-documented full-parallel-`npm test`
        // contamination risk `claim-worker.spec.ts`/T-RAP-047/048/051 already carry"): under a full,
        // unfiltered `npm test` run, some OTHER file's own real, globally-scoped
        // `ActivityLogClaimWorker` (e.g. `test/e2e/full-pipeline*.e2e-spec.ts`) can legitimately
        // claim ANY pending row in the shared `activity_logs` table, including this one, regardless
        // of tenant — `claimNextPendingRow()` is not tenant-scoped. That foreign worker can never
        // drive this row all the way to `'processed'`, though: `RuleEvaluationRowHandler.
        // resolveTrackerContext` throws immediately when it can't find THIS row's own tenant/
        // campaign in ITS OWN cache (a different mock portal, a disjoint tenant-id range per file —
        // `resolveTrackerContext`'s own header), leaving the row `'processing'` for the stale sweep
        // rather than ever completing it — so `'processed'` remains a safe, deterministic negative
        // assertion even under full-suite contamination, while a bare `'pending'` check would not.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const row = await fetchActivityLogRow(sequelize, rowId);
        expect(row?.status).not.toBe('processed');
      } finally {
        await result?.httpApp.close();
      }
    },
  );

  // TC-3
  it("TC-3: Render's existing deployed behavior (nothing enabled) is unaffected — /health is the only live surface", async () => {
    await resetEnvToBaseline();

    let result: HybridBootstrapResult | undefined;
    try {
      result = await startExpectingSuccess();
      expect(result.grpcApp).toBeNull();
      expect(result.ingestConsumerContext).toBeNull();
      expect(result.progressApiApp).toBeNull();
      expect(result.processingWorkerContext).toBeNull();

      const health = await request(result.httpApp.getHttpServer()).get('/health');
      expect(health.status).toBe(200);
    } finally {
      await result?.httpApp.close();
    }
  });
});
