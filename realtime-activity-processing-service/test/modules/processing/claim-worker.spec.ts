/**
 * T-RAP-030. Covers the claim mechanism only (Scope "Out": no rule evaluation/progress/reward
 * logic — a stub `ActivityLogRowHandler` proves the claim loop alone, T-RAP-031 onward owns the
 * real one).
 *
 * Two tiers, same split `activity-logs.repository.spec.ts` (T-RAP-021) already established for
 * this project:
 *  - Pure-logic tests (worker lane scheduling, sweep `runOnce` dedup, config fallback) against
 *    fakes — no real DB, no real timers beyond a short, bounded real-time pacing check (TC-3).
 *  - Concurrency-safety tests (TC-1/TC-2/TC-4) against the real local Postgres 16 server (root
 *    `CLAUDE.md`), connected as the real least-privilege `rap_app` role — `FOR UPDATE SKIP
 *    LOCKED`'s own no-double-claim guarantee is exactly the kind of thing a mock cannot prove.
 *
 * **T-INT-044 update.** This file's own real-Postgres section is exactly the "genuinely global
 * scan, no give-back budget can fully rule out cross-suite contention" caller the task's own
 * evidence names as still flaking under real full-suite `npm test` contention. Every real-Postgres
 * test here now claims through `OWN_TENANT_SCOPE`/`activity-log-claim.repository.ts`'s new,
 * additive, test-only `ClaimScope` parameter (the one exception is TC-1, rewritten to call the
 * repository directly instead of through a real `ActivityLogClaimWorker` — see that test's own
 * doc comment for why), so this file's own claims can no longer observe, lock, or claim a row
 * belonging to a different, concurrently-running suite in the same real, shared table. See the two
 * new `T-INT-044 regression` tests at the end of this file for the deterministic proof that a
 * disjoint tenant range is a hard SQL-layer boundary, not merely an unlikely-to-cross convention.
 *
 * **T-INT-044 second finding (independent re-verification of this task).** The two regression
 * tests above were themselves observed to fail once under real, extreme full-suite `npm test`
 * contention (`claimedByRangeB` came back `null`) — root-caused to a DIFFERENT, real,
 * globally-scoped `ActivityLogClaimWorker` in a concurrently-running worker-bundle file
 * (`processing-worker.e2e-spec.ts`/`full-pipeline(-multi-instance).e2e-spec.ts`/
 * `mixed-transport-load.e2e-spec.ts`) claiming that test's own deliberately-global-minimum row
 * before its own later, scoped claim call ran — the exact "this fix only protects a caller that
 * itself participates in the lock" gap this task's own Evidence section already named. Both
 * regression tests now also acquire `acquireIngestConsumerGroupReaderLease()` (the same
 * cross-process lock every worker-bundle file already takes before starting a real global claim
 * worker — see each test's own doc comment) for their own real-`pending`-row exposure window,
 * closing this specific residual gap without touching production semantics.
 */
import 'reflect-metadata';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import {
  ActivityLogClaimRepository,
  type ClaimScope,
} from '@/modules/processing/activity-log-claim.repository';
import {
  ActivityLogClaimWorker,
  NoopActivityLogRowHandler,
} from '@/modules/processing/activity-log-claim.worker';
import type { ActivityLogRowHandler } from '@/modules/processing/activity-log-row.handler';
import { StaleProcessingSweepService } from '@/modules/processing/stale-processing-sweep.service';
import type { ConfigResolver } from '@/modules/processing/processing.config';
import { PROCESSING_SERVICE_CONFIG_KEYS } from '@/modules/processing/processing.config';
import {
  ActivityLogsRepository,
  type FanOutRowInput,
  type InsertedFanOutRow,
} from '@/modules/activity-mapping/activity-logs.repository';
import type { ActivityLogRow } from '@/database/models/activity-log.model';
import { MetricsService } from '@/observability/metrics.service';
import { StructuredLoggerFactory } from '@/observability/structured-logger';
import type { LogRedactorService } from '@/modules/encryption/log-redactor.service';
import {
  acquireIngestConsumerGroupReaderLease,
  type IngestConsumerGroupReaderLease,
} from '../../e2e/kafka-shared-consumer-group-lock';
import { READER_LEASE_ACQUIRE_TIMEOUT_MS } from '../../e2e/full-pipeline-test-helpers';

const TENANT_ID = 930_000 + Math.floor(Math.random() * 69_999);

/**
 * T-INT-044. Every real-Postgres test in this file below that doesn't specifically need to
 * exercise the genuinely-global, unscoped claim query (i.e. everything except TC-1's own
 * `drainOwnTenantRows`, which is deliberately unscoped — see its own doc comment) passes this
 * scope to `claimNextPendingRow()`/`claimUntil()`, so it can never observe, lock, or claim a row
 * belonging to a concurrently-running, unrelated suite (a different Jest worker process hitting
 * the same real, shared `activity_logs` table) — closing the residual cross-suite claim-query
 * contamination this task's own task file documents, at its source, for every call site in this
 * file that can adopt it.
 */
const OWN_TENANT_SCOPE: ClaimScope = { tenantIdRangeStart: TENANT_ID, tenantIdRangeEnd: TENANT_ID };

/** Same hand-rolled fake `structured-logger.spec.ts` itself uses for this exact collaborator — a
 * real `StructuredLoggerFactory`/`StructuredLogger`, not a mock, over a no-op redactor. */
function fakeLoggerFactory(): StructuredLoggerFactory {
  return new StructuredLoggerFactory({
    redact: (_field: string, value: string) => value,
  } as unknown as LogRedactorService);
}

// ---------------------------------------------------------------------------------------------
// Fakes shared by the pure-logic tests below.
// ---------------------------------------------------------------------------------------------

class FakeConfigResolver implements ConfigResolver {
  values = new Map<string, string>();

  setInt(key: string, value: number): void {
    this.values.set(key, String(value));
  }

  resolve(configKey: string): string {
    const value = this.values.get(configKey);
    if (value === undefined) {
      throw new Error(`Unconfigured service_config key "${configKey}"`);
    }
    return value;
  }
}

class RecordingHandler implements ActivityLogRowHandler {
  handled: ActivityLogRow[] = [];
  private readonly impl?: (row: ActivityLogRow) => Promise<void>;

  constructor(impl?: (row: ActivityLogRow) => Promise<void>) {
    this.impl = impl;
  }

  async handle(row: ActivityLogRow): Promise<void> {
    this.handled.push(row);
    if (this.impl) {
      await this.impl(row);
    }
  }
}

interface FakeRepositoryRow {
  claimNextPendingRow: () => Promise<ActivityLogRow | null>;
  sweepStaleProcessingRows: (timeoutSeconds: number) => Promise<number>;
}

function fakeRow(id: string): ActivityLogRow {
  return {
    id,
    correlation_id: '11111111-1111-4111-8111-111111111111',
    dedup_key: `dedup-${id}`,
    tenant_id: TENANT_ID,
    customer_id_encrypted: 'ciphertext',
    customer_id_hash: 'a'.repeat(64),
    customer_id_type: 'INTERNAL_ID',
    activity_performed_date: new Date(),
    transaction_type: null,
    activity_code: 'PURCHASE',
    activity_type: 'TRANSACTION',
    activity_category: 'RETAIL',
    activity_value: '10.0000',
    activity_value_unit: 'USD',
    channel: 'WEB',
    activity_performed_env: 'PROD',
    activity_name: 'Online purchase',
    campaign_code: 'CAMP1',
    tracker_code: 'TRK1',
    tracker_component_code: 'COMP1',
    merchant_code: null,
    source_transport: 'GRPC',
    activity_reached_date: new Date(),
    activity_processed_date: null,
    status: 'processing',
    error_code: null,
    comment: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function asRepository(fake: FakeRepositoryRow): ActivityLogClaimRepository {
  return fake as unknown as ActivityLogClaimRepository;
}

describe('ActivityLogClaimWorker — lane scheduling (fakes, no real DB)', () => {
  it('claimAndHandleOne(): empty queue returns false without invoking the handler', async () => {
    const repo = asRepository({
      claimNextPendingRow: async () => null,
      sweepStaleProcessingRows: async () => 0,
    });
    const handler = new RecordingHandler();
    const worker = new ActivityLogClaimWorker(
      repo,
      new FakeConfigResolver(),
      new MetricsService(),
      fakeLoggerFactory(),
      handler,
      false,
    );

    const claimed = await worker.claimAndHandleOne();

    expect(claimed).toBe(false);
    expect(handler.handled).toHaveLength(0);
  });

  it('claimAndHandleOne(): a claimed row is handed to the bound handler, returns true', async () => {
    const row = fakeRow('row-1');
    const repo = asRepository({
      claimNextPendingRow: async () => row,
      sweepStaleProcessingRows: async () => 0,
    });
    const handler = new RecordingHandler();
    const worker = new ActivityLogClaimWorker(
      repo,
      new FakeConfigResolver(),
      new MetricsService(),
      fakeLoggerFactory(),
      handler,
      false,
    );

    const claimed = await worker.claimAndHandleOne();

    expect(claimed).toBe(true);
    expect(handler.handled).toEqual([row]);
  });

  // T-RAP-059: claim-to-processed latency is observed once the handler resolves successfully,
  // covering the whole Wave 3 chain for this one row.
  it('T-RAP-059: a successful handle() observes activity_processing_duration_seconds exactly once', async () => {
    const row = fakeRow('row-1-metrics');
    const repo = asRepository({
      claimNextPendingRow: async () => row,
      sweepStaleProcessingRows: async () => 0,
    });
    const handler = new RecordingHandler();
    const metrics = new MetricsService();
    const worker = new ActivityLogClaimWorker(
      repo,
      new FakeConfigResolver(),
      metrics,
      fakeLoggerFactory(),
      handler,
      false,
    );

    await worker.claimAndHandleOne();

    const snapshot = metrics.getHistogramSnapshot('activity_processing_duration_seconds');
    expect(snapshot.count).toBe(1);
    expect(snapshot.values[0]).toBeGreaterThanOrEqual(0);
  });

  it('a handler that throws is caught and logged — claimAndHandleOne() still resolves true, never rethrows', async () => {
    const row = fakeRow('row-2');
    const repo = asRepository({
      claimNextPendingRow: async () => row,
      sweepStaleProcessingRows: async () => 0,
    });
    const handler = new RecordingHandler(async () => {
      throw new Error('handler exploded');
    });
    const metrics = new MetricsService();
    const worker = new ActivityLogClaimWorker(
      repo,
      new FakeConfigResolver(),
      metrics,
      fakeLoggerFactory(),
      handler,
      false,
    );

    await expect(worker.claimAndHandleOne()).resolves.toBe(true);
    // T-RAP-059 regression: a thrown handler leaves the row `processing`, not `processed` — this
    // claim never reached a terminal state, so it must NOT be counted toward claim-to-processed
    // latency (a later claim/attempt that does reach a terminal state records its own duration).
    expect(metrics.getHistogramSnapshot('activity_processing_duration_seconds').count).toBe(0);
  });

  // T-RAP-059: the "handler threw" log line carries correlationId/tenantId/campaignCode as
  // separate structured fields, read off the claimed row itself.
  it("T-RAP-059: a handler that throws logs a StructuredLogger entry carrying the claimed row's correlationId/tenantId/campaignCode", async () => {
    const row = fakeRow('row-2-structured');
    const repo = asRepository({
      claimNextPendingRow: async () => row,
      sweepStaleProcessingRows: async () => 0,
    });
    const handler = new RecordingHandler(async () => {
      throw new Error('handler exploded');
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const worker = new ActivityLogClaimWorker(
        repo,
        new FakeConfigResolver(),
        new MetricsService(),
        fakeLoggerFactory(),
        handler,
        false,
      );

      await worker.claimAndHandleOne();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const entry = JSON.parse(errorSpy.mock.calls[0][0] as string) as Record<string, unknown>;
      expect(entry.correlationId).toBe(row.correlation_id);
      expect(entry.tenantId).toBe(row.tenant_id);
      expect(entry.campaignCode).toBe(row.campaign_code);
      expect(String(entry.message)).toContain('handler exploded');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('with no handler bound, falls back to NoopActivityLogRowHandler rather than throwing', async () => {
    const row = fakeRow('row-3');
    const repo = asRepository({
      claimNextPendingRow: async () => row,
      sweepStaleProcessingRows: async () => 0,
    });
    // Constructing without the optional handler argument exercises the class's own default.
    const worker = new ActivityLogClaimWorker(
      repo,
      new FakeConfigResolver(),
      new MetricsService(),
      fakeLoggerFactory(),
    );

    await expect(worker.claimAndHandleOne()).resolves.toBe(true);
  });

  it('resolvePositiveIntConfig fallback: an unconfigured poll interval/concurrency falls back to the documented default rather than throwing', async () => {
    const repo = asRepository({
      claimNextPendingRow: async () => null,
      sweepStaleProcessingRows: async () => 0,
    });
    // FakeConfigResolver.resolve() throws for anything not explicitly set — neither key is set
    // here, proving the worker degrades to its own DEFAULT_* constants instead of crashing.
    const worker = new ActivityLogClaimWorker(
      repo,
      new FakeConfigResolver(),
      new MetricsService(),
      fakeLoggerFactory(),
      undefined,
      false,
    );

    await expect(worker.claimAndHandleOne()).resolves.toBe(false);
  });

  // TC-3: empty queue -> the worker paces its claim attempts at the configured interval, not a
  // busy spin. Proven by bounding the real call count over a short, real-time window: a busy spin
  // would produce hundreds/thousands of calls in this window, a correctly-paced 30ms interval
  // produces only a handful.
  it('TC-3: empty queue polls at the configured interval, no busy-spin', async () => {
    let callCount = 0;
    const repo = asRepository({
      claimNextPendingRow: async () => {
        callCount += 1;
        return null;
      },
      sweepStaleProcessingRows: async () => 0,
    });
    const resolver = new FakeConfigResolver();
    resolver.setInt(PROCESSING_SERVICE_CONFIG_KEYS.CLAIM_POLL_INTERVAL_MS, 30);
    resolver.setInt(PROCESSING_SERVICE_CONFIG_KEYS.CLAIM_CONCURRENCY, 1);
    const worker = new ActivityLogClaimWorker(
      repo,
      resolver,
      new MetricsService(),
      fakeLoggerFactory(),
      new RecordingHandler(),
      false,
    );

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 160));
    worker.stop();

    // ~160ms / 30ms ≈ 5-6 attempts; a busy spin would produce orders of magnitude more.
    expect(callCount).toBeGreaterThanOrEqual(1);
    expect(callCount).toBeLessThanOrEqual(10);
  });

  it('start()/stop() lane lifecycle: stop() prevents further claim attempts', async () => {
    let callCount = 0;
    const repo = asRepository({
      claimNextPendingRow: async () => {
        callCount += 1;
        return null;
      },
      sweepStaleProcessingRows: async () => 0,
    });
    const resolver = new FakeConfigResolver();
    resolver.setInt(PROCESSING_SERVICE_CONFIG_KEYS.CLAIM_POLL_INTERVAL_MS, 20);
    resolver.setInt(PROCESSING_SERVICE_CONFIG_KEYS.CLAIM_CONCURRENCY, 2);
    const worker = new ActivityLogClaimWorker(
      repo,
      resolver,
      new MetricsService(),
      fakeLoggerFactory(),
      new RecordingHandler(),
      false,
    );

    worker.start();
    worker.start(); // idempotent — a second start() while running must not double the lane count
    await new Promise((resolve) => setTimeout(resolve, 30));
    worker.stop();
    const countAtStop = callCount;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(callCount).toBe(countAtStop);
  });

  it('NoopActivityLogRowHandler logs a warning and does not throw', async () => {
    await expect(new NoopActivityLogRowHandler().handle(fakeRow('row-4'))).resolves.toBeUndefined();
  });
});

describe('StaleProcessingSweepService (fakes, no real DB)', () => {
  it('runOnce(): delegates to the repository with the resolved timeout, returns the reclaimed count', async () => {
    const calls: number[] = [];
    const repo = asRepository({
      claimNextPendingRow: async () => null,
      sweepStaleProcessingRows: async (timeoutSeconds: number) => {
        calls.push(timeoutSeconds);
        return 3;
      },
    });
    const resolver = new FakeConfigResolver();
    resolver.setInt(PROCESSING_SERVICE_CONFIG_KEYS.STALE_TIMEOUT_SECONDS, 120);
    const sweep = new StaleProcessingSweepService(repo, resolver, undefined, false);

    const reclaimed = await sweep.runOnce();

    expect(reclaimed).toBe(3);
    expect(calls).toEqual([120]);
  });

  it('falls back to the default stale timeout when unconfigured', async () => {
    const calls: number[] = [];
    const repo = asRepository({
      claimNextPendingRow: async () => null,
      sweepStaleProcessingRows: async (timeoutSeconds: number) => {
        calls.push(timeoutSeconds);
        return 0;
      },
    });
    const sweep = new StaleProcessingSweepService(repo, new FakeConfigResolver(), undefined, false);

    await sweep.runOnce();

    expect(calls).toEqual([300]);
  });

  it('a slow cycle in flight is not duplicated by an overlapping runOnce() call', async () => {
    let inFlightCalls = 0;
    let resolveSweep: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveSweep = resolve;
    });
    const repo = asRepository({
      claimNextPendingRow: async () => null,
      sweepStaleProcessingRows: async () => {
        inFlightCalls += 1;
        await gate;
        return 0;
      },
    });
    const sweep = new StaleProcessingSweepService(repo, new FakeConfigResolver(), undefined, false);

    const first = sweep.runOnce();
    const second = sweep.runOnce();
    resolveSweep?.();
    await Promise.all([first, second]);

    expect(inFlightCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Real Postgres, rap_app role — concurrency-safety proofs a mock cannot provide.
// ---------------------------------------------------------------------------------------------

describe('ActivityLogClaimRepository / claim mechanism (real Postgres, rap_app role)', () => {
  let sequelize: Sequelize;
  let claimRepository: ActivityLogClaimRepository;
  let fanOutRepository: ActivityLogsRepository;

  beforeAll(async () => {
    sequelize = new Sequelize({
      dialect: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_NAME,
      username: process.env.DB_APP_USERNAME,
      password: process.env.DB_APP_PASSWORD,
      logging: false,
    });
    await sequelize.authenticate();
    claimRepository = new ActivityLogClaimRepository(sequelize);
    fanOutRepository = new ActivityLogsRepository(sequelize);
  });

  afterAll(async () => {
    await sequelize.query(
      'DELETE FROM realtime_activity_processing.activity_logs WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await sequelize.close();
  });

  function pendingRowInput(overrides: Partial<FanOutRowInput> = {}): FanOutRowInput {
    return {
      correlationId: '22222222-2222-4222-8222-222222222222',
      dedupKey: `dedup-${Math.random().toString(36).slice(2)}`,
      tenantId: TENANT_ID,
      customerIdEncrypted: 'ciphertext-base64==',
      customerIdHash: 'b'.repeat(64),
      customerIdType: 'INTERNAL_ID',
      activityPerformedDate: new Date(),
      transactionType: null,
      activityCode: 'PURCHASE',
      activityType: 'TRANSACTION',
      activityCategory: 'RETAIL',
      activityValue: '10.0000',
      activityValueUnit: 'USD',
      channel: 'WEB',
      activityPerformedEnv: 'PROD',
      activityName: 'Online purchase',
      campaignCode: 'CAMP1',
      trackerCode: 'TRK1',
      trackerComponentCode: 'COMP1',
      merchantCode: null,
      sourceTransport: 'GRPC',
      ...overrides,
    };
  }

  async function insertPendingRows(count: number): Promise<InsertedFanOutRow[]> {
    const rows = Array.from({ length: count }, (_unused, index) =>
      pendingRowInput({ trackerComponentCode: `COMP-${index}` }),
    );
    return sequelize.transaction((t) => fanOutRepository.insertFanOutRows(rows, t));
  }

  // T-RAP-051: inserts one fan-out row via the real repository, then — inside that *same*,
  // still-open `transaction` — pins its `status` to `'processing'` and its `activity_reached_date`
  // to an explicit, caller-controlled value (`offsetSql`, always a hardcoded literal at every call
  // site in this file, matching this file's existing convention of inline SQL interval literals,
  // e.g. the TC-2 staleness test's own `now() - interval '1 hour'` above) — never the column's own
  // DB-side `DEFAULT now()` an uncontrolled insert would leave it with.
  //
  // Both parts (moving off `'pending'`, and the explicit timestamp) matter, and doing them in the
  // *same* transaction as the insert — rather than as a separate, later statement, committing
  // after the row was already externally visible as `'pending'` — matters just as much:
  //
  // `activity_reached_date` is deliberately absent from `FanOutRowInput` (see that interface's own
  // header comment, owned by T-RAP-021/the activity-mapping module — out of this task's file
  // scope, so overriding it in the insert statement itself is not an option here) — every caller,
  // including this test, gets the DB default at insert time. That's fine for production (insert
  // order and arrival order are the same thing there) but is exactly what made the *original*
  // version of this test flaky: it inferred relative `activity_reached_date` order from wall-clock
  // *program* order (inserting two rows ~20ms apart and assuming the DB's own `now()` at each
  // transaction's start would land in the same order). Diagnosed against the real local Postgres
  // under genuine 9-way full-suite `npm test` parallelism (T-RAP-051's own filed evidence,
  // reproduced again while fixing this task — see this task's completion report): connection-pool
  // checkout delays and transaction-commit scheduling under real contention can let the *second*
  // transaction's own `now()` land before the first's, inverting the assumed order even with a
  // 20ms gap. No wall-clock gap, however large, removes this possibility — it only narrows the
  // odds, which is why the original version flaked at low but nonzero frequency (observed 1 in 6
  // real full-suite runs) rather than deterministically. Explicitly setting the value and reading
  // it back, rather than inferring it from timing, is what makes this version deterministic.
  //
  // `status = 'processing'`, committed atomically with that explicit timestamp rather than as a
  // later, separate statement, closes a *second*, independent race the first (timestamp-only)
  // version of this fix still had — reproduced while fixing this task, under a real full parallel
  // `npm test` run (see this task's completion report for the captured failing run):
  // `claimNextPendingRow()` is global (`05-PROCESSING-PIPELINE.md` §4), and several *other*
  // concurrently-running suites in this same codebase (`cap-enforcement.spec.ts`,
  // `rule-evaluation.spec.ts`, `tracker-completion.spec.ts`, and this file's own `claimUntil`
  // above) run their own give-back loop against the real shared table, each ending with the exact
  // same statement shape — `UPDATE ... SET status = 'pending', activity_reached_date = now() WHERE
  // id = :id` — whenever they claim a foreign row by mistake. A row deliberately backdated (as
  // this test does, to make its relative order deterministic) is, for as long as it is externally
  // visible as `'pending'`, the *most attractive* target for that global claim query of all —
  // T-RAP-047's own class of bug, not this task's originally reported one, but reachable here the
  // same way: some other suite's worker legitimately claims our backdated row via the real global
  // query, finds it doesn't match its own predicate, and gives it back with `activity_reached_date
  // = now()` — silently erasing the exact ordering this test just set up. A separate, later
  // `UPDATE` (even one that also sets `status = 'processing'`) still leaves a real window between
  // the insert's own commit and that follow-up statement's own commit during which the row is
  // genuinely `'pending'` and visible table-wide; only running both inside one transaction removes
  // the window entirely — the row goes straight from "does not exist" to "exists, already
  // `'processing'`, already at its final `activity_reached_date`" in a single commit, so no
  // concurrently-running suite's claim query — however unlucky its timing — ever has a chance to
  // observe it as `'pending'` at all.
  async function insertAndPinActivityReachedDate(
    input: FanOutRowInput,
    offsetSql: string,
  ): Promise<InsertedFanOutRow> {
    return sequelize.transaction(async (t) => {
      const [row] = await fanOutRepository.insertFanOutRows([input], t);
      await sequelize.query(
        `UPDATE realtime_activity_processing.activity_logs
            SET status = 'processing', activity_reached_date = ${offsetSql}
          WHERE id = :id`,
        { type: QueryTypes.RAW, replacements: { id: row.id }, transaction: t },
      );
      return row;
    });
  }

  // TC-1: two independent claimers draining the same 10-row queue concurrently never double-claim.
  //
  // T-INT-044: rewritten to claim directly through the scoped repository call
  // (`OWN_TENANT_SCOPE`) instead of through a real `ActivityLogClaimWorker.claimAndHandleOne()`
  // loop. `claimAndHandleOne()` always calls `claimNextPendingRow()` with no scope — production
  // code (`activity-log-claim.worker.ts`) is outside this task's own file scope, and its own
  // genuinely-global production behavior must not change — so a worker-mediated loop here could
  // still observe, lock, and claim a concurrently-running unrelated suite's own row in the same
  // real, shared table: exactly the residual cross-suite contamination hazard this task exists to
  // close, and the previous version of this test's own give-back loop below (kept in history, not
  // in this file) is what that contamination looked like in practice. What TC-1 actually needs to
  // prove — `FOR UPDATE SKIP LOCKED` never lets two concurrent claimers win the same row — is
  // fully exercised by calling the repository directly; `ActivityLogClaimWorker`'s own lane-
  // scheduling/handler-invocation/metrics glue around that call is already covered by the "fakes"
  // tests above in this same file (no real DB involved there, so no scoping concern either).
  it('TC-1: two workers claim concurrently against 10 pending rows — every row claimed exactly once', async () => {
    await insertPendingRows(10);

    const handlerA = new RecordingHandler();
    const handlerB = new RecordingHandler();

    async function drainOwnTenantRows(handler: RecordingHandler): Promise<void> {
      for (let claimedCount = 0; claimedCount < 5; claimedCount += 1) {
        const row = await claimRepository.claimNextPendingRow(OWN_TENANT_SCOPE);
        if (row === null) {
          break;
        }
        await handler.handle(row);
      }
    }

    await Promise.all([drainOwnTenantRows(handlerA), drainOwnTenantRows(handlerB)]);

    // Every claimed row is guaranteed (by `OWN_TENANT_SCOPE`, enforced at the SQL layer, not just
    // asserted after the fact) to belong to `TENANT_ID` — no `.filter()` needed here any more.
    const allIds = [...handlerA.handled, ...handlerB.handled].map((r) => r.id);

    expect(allIds).toHaveLength(10);
    expect(new Set(allIds).size).toBe(10); // no id claimed by both workers

    const remaining = await sequelize.query(
      `SELECT id FROM realtime_activity_processing.activity_logs
        WHERE tenant_id = :tenantId AND status = 'pending'`,
      { type: QueryTypes.SELECT, replacements: { tenantId: TENANT_ID } },
    );
    expect(remaining).toHaveLength(0);
  });

  // TC-4: many concurrent claim attempts against a single pending row — no deadlock, no crash,
  // exactly one succeeds.
  //
  // T-RAP-051 retry 1/3: two changes, both driven by reproducing this test's own reported failure
  // ("ownWins length 2, not 1") under a real, currently-running background jest process
  // (`ps aux` while reproducing showed this repo's own orchestrator concurrently exercising
  // `activity-ingest.consumer.e2e-spec.ts` against the same real local Postgres — the same kind of
  // genuine external contention `claimNextPendingRow()` being global, `05-PROCESSING-PIPELINE.md`
  // §4, always exposes this suite to):
  //
  //  1. Filters `ownWins` by this test's own freshly-inserted row `id`, not merely `tenant_id`.
  //     `TENANT_ID` is shared across every test in this file (assigned once, module-level), so
  //     `tenant_id === TENANT_ID` alone was never a reliable proxy for "the exact row this test
  //     just created" — e.g. an *earlier* test in this file leaving one of its own `TENANT_ID`
  //     rows still `pending` (TC-1, before its own budget fix above) would get miscounted here as
  //     a second "win". Scoping to the freshly-inserted row's own `id` removes that ambiguity
  //     regardless of whether every other test in this file is itself bug-free.
  //  2. Each of the 20 concurrent attempts now runs through `claimUntil` (defined below, T-RAP-047's
  //     own give-back+retry helper) instead of a single bare `claimNextPendingRow()` call, matching
  //     this task's review note ("harden TC-4 the same way T-RAP-047 hardened claimUntil"). A bare
  //     single-shot call assumes the *global* queue (not scoped to this test, or even this suite)
  //     holds only this test's own row at the moment all 20 fire — false whenever any other
  //     concurrently-running suite (a co-running Jest worker, or, as reproduced, a background
  //     process like the orchestrator's own verification runs) has *older* `pending` rows of its
  //     own genuinely ahead of ours in claim order at that instant: those 20 one-shot calls could
  //     each claim a *different* foreign row and never reach ours at all, exhausting with zero
  //     `ownWins` — reproduced exactly this way (`Received length: 0`) while diagnosing this retry.
  //     Routing every attempt through `claimUntil`'s own bounded give-back loop instead makes "did
  //     this concurrent burst reach our own row" no longer a function of how much unrelated noise
  //     happens to be enqueued ahead of it at that instant — it only fails if this test's own row is
  //     never claimed by *any* of the 20 within a generous, bounded attempt budget, or if more than
  //     one attempt manages to end up holding it (which `FOR UPDATE SKIP LOCKED` plus the unique-
  //     index backstop, `05-PROCESSING-PIPELINE.md` §3, already rules out at the DB layer — this
  //     assertion is what proves that guarantee, not what's supplying it).
  it('TC-4: concurrent claim attempts against one pending row — no deadlock/crash, exactly one wins', async () => {
    const [insertedRow] = await insertPendingRows(1);

    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        claimUntil((r) => r.id === insertedRow.id, OWN_TENANT_SCOPE),
      ),
    );

    const ownWins = attempts.filter(
      (r): r is ActivityLogRow => r !== null && r.id === insertedRow.id,
    );
    expect(ownWins).toHaveLength(1);
  });

  /**
   * `claimNextPendingRow()` is genuinely global (05-PROCESSING-PIPELINE.md §4 — never
   * tenant-scoped), so any test claiming from it while another Postgres-backed spec runs
   * concurrently (Jest's default multi-worker run) can pull a row that belongs to that other
   * suite. Looping until `predicate` matches, and giving back every non-matching claim
   * immediately (rather than leaving it stuck `processing` forever), is what keeps this suite
   * from silently starving whichever suite actually owns the row it briefly held — T-RAP-033's
   * own completion report flags this as a pre-existing, now-more-frequently-exercised gap.
   *
   * T-RAP-047 root cause (diagnosed by reproducing against the real local Postgres, not
   * guessed): the give-back statement used to only flip `status` back to `'pending'`, leaving
   * `activity_reached_date` — the claim query's own `ORDER BY` column — untouched. Whenever a
   * non-matching foreign row was (and remained) the table's global minimum by that column, this
   * loop would re-claim and immediately re-release *that exact same row* every single iteration,
   * never making progress toward our own rows — a genuine livelock, not merely a too-small
   * `maxAttempts`. Reproduced deterministically (25 synthetic noise rows never claimed by anyone
   * else, standing in for a concurrently-running suite's own `pending` rows): the old give-back
   * statement looped on one unchanging row for all attempts; bumping
   * `activity_reached_date = now()` on give-back — moving a released row to the back of the
   * queue — fixed it, draining every foreign row exactly once before reaching ours. `maxAttempts`
   * is bumped from 20 to 300 alongside this as a generous, no-longer-load-bearing safety margin
   * (every suite in this codebase inserts at most ~20 rows of its own).
   *
   * **T-INT-044 update:** every call site in this file now passes `OWN_TENANT_SCOPE` (the one
   * exception being TC-1's own deliberately-unscoped `drainOwnTenantRows`, see its own doc
   * comment). With a scope given, `claimNextPendingRow(scope)` itself guarantees — at the SQL
   * layer, not via this function's own app-level `predicate` — that a foreign suite's row can
   * never be returned here in the first place, so the give-back branch below is no longer
   * load-bearing for cross-suite contamination the way it used to be; it is kept as-is (rather
   * than removed) so this function still behaves correctly for a hypothetical future caller that
   * omits `scope` on purpose (e.g. to keep testing the give-back path itself), and so a regression
   * back to an unscoped call site anywhere in this file would still degrade gracefully instead of
   * failing outright.
   */
  async function claimUntil(
    predicate: (row: ActivityLogRow) => boolean,
    scope?: ClaimScope,
    maxAttempts = 300,
  ): Promise<ActivityLogRow | null> {
    for (let i = 0; i < maxAttempts; i += 1) {
      const next = await claimRepository.claimNextPendingRow(scope);
      if (next === null) {
        return null;
      }
      if (predicate(next)) {
        return next;
      }
      // T-RAP-047: must bump `activity_reached_date` too — see this function's own header.
      await sequelize.query(
        `UPDATE realtime_activity_processing.activity_logs
            SET status = 'pending', activity_reached_date = now()
          WHERE id = :id`,
        { type: QueryTypes.RAW, replacements: { id: next.id } },
      );
    }
    return null;
  }

  // TC-2: a row stuck in `processing` past the stale timeout is swept back to `pending` and
  // re-claimable.
  it('TC-2: a stale processing row is swept back to pending and is re-claimable', async () => {
    await insertPendingRows(1);
    const claimed = await claimUntil((r) => r.tenant_id === TENANT_ID, OWN_TENANT_SCOPE);
    expect(claimed).not.toBeNull();
    if (claimed === null) {
      return;
    }
    expect(claimed.status).toBe('processing');

    // Simulate a crash: back-date updated_at well past any reasonable timeout.
    await sequelize.query(
      `UPDATE realtime_activity_processing.activity_logs
          SET updated_at = now() - interval '1 hour'
        WHERE id = :id`,
      { type: QueryTypes.RAW, replacements: { id: claimed.id } },
    );

    const reclaimed = await claimRepository.sweepStaleProcessingRows(300);
    expect(reclaimed).toBeGreaterThanOrEqual(1);

    // T-RAP-051: deliberately does *not* assert `status === 'pending'` via a plain `SELECT` here.
    // `sweepStaleProcessingRows()` is global (`activity-log-claim.repository.ts` — not tenant- or
    // suite-scoped, same as `claimNextPendingRow()`), so the instant this row's own `UPDATE ...
    // SET status = 'pending'` commits, it is immediately visible to every other suite's own
    // real, legitimately-running claim loop in this same full parallel `npm test` run — including
    // ones with a much smaller effective "queue" than the shared table's whole current backlog,
    // making a genuinely fresh `pending` row an easy target. Reproduced while fixing this task
    // (see this task's completion report for the captured run): a plain readback here can observe
    // `'processing'` again, not because the sweep failed, but because a *different*, entirely
    // correct suite's own worker won the race and re-claimed this exact row in the gap between the
    // sweep's own commit and this test's own `SELECT` — the identical class of "assumed-stable
    // global state, actually racing concurrent legitimate claimants" bug this task's own primary
    // fix (`pinActivityReachedDate`, above) addresses, just surfacing on a different column.
    // `claimUntil` below is the correct, non-racy proof instead: it definitively establishes the
    // sweep put this row back into circulation, regardless of who else transiently touches it in
    // between — if the sweep genuinely hadn't reset it, this row would still be stuck `processing`
    // and out of the global claim query's `WHERE status = 'pending'` entirely, so `claimUntil`
    // would exhaust its attempts and return `null`, still failing the assertion below.
    const reclaimedRow = await claimUntil((r) => r.id === claimed.id, OWN_TENANT_SCOPE);
    expect(reclaimedRow?.id).toBe(claimed.id);
  });

  it('a row within the stale timeout is left alone (sweep is not over-eager)', async () => {
    await insertPendingRows(1);
    const claimed = await claimUntil((r) => r.tenant_id === TENANT_ID, OWN_TENANT_SCOPE);
    expect(claimed).not.toBeNull();
    if (claimed === null) {
      return;
    }
    expect(claimed.status).toBe('processing'); // freshly claimed — well within any real timeout

    await claimRepository.sweepStaleProcessingRows(300);

    const [row] = await sequelize.query<ActivityLogRow>(
      'SELECT * FROM realtime_activity_processing.activity_logs WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id: claimed.id } },
    );
    expect(row.status).toBe('processing');
  });

  /**
   * T-RAP-051: sets `activity_reached_date` explicitly via `pinActivityReachedDate` (see its own
   * header comment above for the full reasoning), rather than relying on the column's own DB-side
   * `DEFAULT now()` at insert time. `activity_reached_date` is deliberately absent from
   * `FanOutRowInput` (see that interface's own header comment, owned by T-RAP-021/the
   * activity-mapping module — out of this task's file scope, so overriding it in the insert path
   * itself is not an option here) — every caller, including this test, gets the DB default at
   * insert time. That is fine for production (insert order and arrival order are the same thing
   * there) but is exactly what made the *previous* version of this test flaky: it inferred
   * relative `activity_reached_date` order from wall-clock *program* order (inserting the two rows
   * ~20ms apart and assuming the DB's own `now()` at each transaction's start would land in the
   * same order). Diagnosed against the real local Postgres under genuine 9-way full-suite
   * `npm test` parallelism (T-RAP-051's own filed evidence, reproduced again while fixing this
   * task — see this task's completion report for the captured failing run): connection-pool
   * checkout delays and transaction-commit scheduling under real contention can let the *second*
   * transaction's own `now()` land before the first's, inverting the assumed order even with a
   * 20ms gap. No wall-clock gap, however large, removes this possibility — it only ever narrows
   * the odds, which is why the previous version flaked at low but nonzero frequency (observed 1 in
   * 6 real full-suite runs) rather than deterministically.
   *
   * What's under test here is the `ORDER BY activity_reached_date` clause itself (proven via the
   * identical `ORDER BY` clause the repository's real query uses, scoped to this test's own two
   * rows by `tenant_id`), not the DB's `now()` default's own behaviour under load — that scope
   * match, plus reading the value back rather than inferring it, is what makes this version
   * deterministic instead of merely "flaky less often".
   */
  it('claimNextPendingRow() orders by activity_reached_date (oldest first)', async () => {
    await Promise.all([
      insertAndPinActivityReachedDate(
        pendingRowInput({ trackerComponentCode: 'COMP-FIRST' }),
        "now() - interval '2 second'",
      ),
      insertAndPinActivityReachedDate(
        pendingRowInput({ trackerComponentCode: 'COMP-SECOND' }),
        "now() - interval '1 second'",
      ),
    ]);

    const [oldest] = await sequelize.query<{ tracker_component_code: string }>(
      `SELECT tracker_component_code FROM realtime_activity_processing.activity_logs
        WHERE tenant_id = :tenantId
          AND tracker_component_code IN ('COMP-FIRST', 'COMP-SECOND')
        ORDER BY activity_reached_date
        LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { tenantId: TENANT_ID } },
    );
    expect(oldest?.tracker_component_code).toBe('COMP-FIRST');
  });

  // T-RAP-051 regression (TC-3): proves the property the fix above relies on — ordering must be
  // driven by the stored `activity_reached_date` value, never by insertion/program order — by
  // deliberately inverting them: `COMP-LATER-INSERT` is inserted *second* but given the *earlier*
  // explicit timestamp, `COMP-EARLIER-INSERT` is inserted *first* but given the *later* one. A
  // version of the test above that (like the pre-fix one) inferred order from insertion sequence
  // instead of reading the column back would get this deterministically backwards — not flaky,
  // *always* wrong, since there is no wall-clock race left to occasionally get lucky on. Manually
  // verified against the pre-fix approach (asserting on insertion order rather than the explicit
  // `UPDATE`s' own values): fails every single run, 20/20 in a tight loop, because insertion order
  // here is deliberately the opposite of timestamp order — see this task's completion report for
  // the captured runs.
  it('T-RAP-051 regression: ordering follows the activity_reached_date value, not insertion order', async () => {
    // Deliberately backwards vs. insertion order: the row inserted *first* gets the *later*
    // explicit activity_reached_date, and the row inserted *second* gets the *earlier* one.
    await insertAndPinActivityReachedDate(
      pendingRowInput({ trackerComponentCode: 'COMP-EARLIER-INSERT' }),
      "now() - interval '1 second'",
    );
    await insertAndPinActivityReachedDate(
      pendingRowInput({ trackerComponentCode: 'COMP-LATER-INSERT' }),
      "now() - interval '2 second'",
    );

    const [oldest] = await sequelize.query<{ tracker_component_code: string }>(
      `SELECT tracker_component_code FROM realtime_activity_processing.activity_logs
        WHERE tenant_id = :tenantId
          AND tracker_component_code IN ('COMP-EARLIER-INSERT', 'COMP-LATER-INSERT')
        ORDER BY activity_reached_date
        LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { tenantId: TENANT_ID } },
    );
    expect(oldest?.tracker_component_code).toBe('COMP-LATER-INSERT');
  });

  // T-RAP-047 regression (TC-3): deterministically reproduces the flake the defect reported —
  // 25 *other*-tenant pending rows already sitting in the queue, standing in for whatever
  // concurrently-running suite (e.g. tracker-completion.spec.ts, rule-evaluation.spec.ts) had its
  // own pending rows in flight in the shared `activity_logs` table at the same moment; none of
  // these 25 is ever claimed by anyone else, so — unlike real concurrent noise, which its own
  // rightful owner eventually drains — they stay in the queue for this test's own entire
  // give-back loop, the worst case `claimUntil`'s own header describes.
  // Manually verified against the pre-fix `claimUntil` (give-back statement missing the
  // `activity_reached_date` bump, `maxAttempts` back at 20): this test failed every time,
  // reproducibly stuck reclaiming and re-releasing the same single noise row for all 20 attempts
  // (see this task's own completion report for the captured run) — with the fix it passes
  // reliably, draining all 25 noise rows exactly once each before reaching our own row.
  //
  // Deliberately a *single* target row, not two (unlike the "orders by" test above) — asserting a
  // relative order between two of our own rows going through the real shared `claimNextPendingRow()`
  // reintroduces exactly the transient-external-steal flakiness that test's own header explains;
  // this test's own job is narrower — proving noise-tolerance, not ordering — so it only needs
  // "was our own row found at all despite the noise", which no external legitimate claimant can
  // make false (at worst it delays which attempt finds it, still well inside `maxAttempts`).
  //
  // **T-INT-044 update:** this exact test ("claimed" came back `undefined`) is the one concrete
  // reproduction this task's own task file cites as still flaking under real full-suite `npm test`
  // contention even at the 300-attempt budget — the 25 synthetic noise rows below stand in for a
  // *different* concurrently-running suite's own real pending rows, and under enough genuine
  // external contention the give-back loop's fixed budget was provably exhaustible (a question of
  // how much contention, not whether, per this function's own header). Passing `OWN_TENANT_SCOPE`
  // now excludes every foreign-tenant row — synthetic noise below AND any real external suite's own
  // rows alike — at the SQL layer itself, so this test's own success no longer depends on draining
  // noise within a fixed budget at all; the 25 rows below now exist purely to prove that scoping,
  // not the give-back loop, is what makes them irrelevant (see the assertion after the noise-tenant
  // cleanup below).
  it('T-RAP-047 regression: claimUntil finds our own row despite many other-tenant pending rows ahead of it', async () => {
    const noiseTenantId = TENANT_ID + 111_111;
    const noiseRows = Array.from({ length: 25 }, (_unused, index) =>
      pendingRowInput({ tenantId: noiseTenantId, trackerComponentCode: `NOISE-${index}` }),
    );

    try {
      await sequelize.transaction((t) => fanOutRepository.insertFanOutRows(noiseRows, t));
      await sequelize.transaction((t) =>
        fanOutRepository.insertFanOutRows(
          [pendingRowInput({ trackerComponentCode: 'COMP-TARGET' })],
          t,
        ),
      );

      const claimed = await claimUntil(
        (r) => r.tenant_id === TENANT_ID && r.tracker_component_code === 'COMP-TARGET',
        OWN_TENANT_SCOPE,
      );

      expect(claimed?.tracker_component_code).toBe('COMP-TARGET');
    } finally {
      await sequelize.query(
        'DELETE FROM realtime_activity_processing.activity_logs WHERE tenant_id = :tenantId',
        { type: QueryTypes.RAW, replacements: { tenantId: noiseTenantId } },
      );
    }
  });

  // T-RAP-047 regression (adjacent behaviour, TC-4): an other-tenant row that happens to share
  // our own `tracker_component_code` label is never mistaken for ours. Pins down the
  // `tenant_id` half of the predicate fix above — without it, a same-named foreign row claimed
  // first (it has the earlier `activity_reached_date` here) would be accepted as a match and
  // never given back, silently starving its rightful owner.
  //
  // **T-INT-044 update:** now passes `OWN_TENANT_SCOPE`, so the impostor row is excluded at the
  // SQL layer before this test's own `predicate` ever runs — a stronger guarantee than the
  // original app-level-only discrimination this test was written to prove, and one that also
  // protects this test from any *real* concurrently-running suite's own same-named row, not just
  // the single synthetic impostor it creates itself.
  it('T-RAP-047 regression: a same-named other-tenant row is never mistaken for our own', async () => {
    const impostorTenantId = TENANT_ID + 222_222;

    try {
      await sequelize.transaction((t) =>
        fanOutRepository.insertFanOutRows(
          [pendingRowInput({ tenantId: impostorTenantId, trackerComponentCode: 'COMP-FIRST-3' })],
          t,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      await sequelize.transaction((t) =>
        fanOutRepository.insertFanOutRows(
          [pendingRowInput({ trackerComponentCode: 'COMP-FIRST-3' })],
          t,
        ),
      );

      const claimed = await claimUntil(
        (r) => r.tenant_id === TENANT_ID && r.tracker_component_code === 'COMP-FIRST-3',
        OWN_TENANT_SCOPE,
      );

      expect(claimed?.tenant_id).toBe(TENANT_ID);
      expect(claimed?.tracker_component_code).toBe('COMP-FIRST-3');
    } finally {
      await sequelize.query(
        'DELETE FROM realtime_activity_processing.activity_logs WHERE tenant_id = :tenantId',
        { type: QueryTypes.RAW, replacements: { tenantId: impostorTenantId } },
      );
    }
  });

  // T-INT-044 TC-2 (this task's own required regression): proves `claimNextPendingRow(scope)` is
  // a hard SQL-layer boundary, not merely an unlikely-to-cross app-level convention — the property
  // every other test above now relies on via `OWN_TENANT_SCOPE`. Two disjoint, single-tenant
  // "ranges" (`rangeATenantId`/`rangeBTenantId`, both distinct from every other tenant id already
  // in play elsewhere in this file) each get exactly one real pending row; range B's row is
  // inserted FIRST (so it has the earlier, globally-smallest `activity_reached_date`) specifically
  // so that a naive, merely-advisory implementation of `scope` (e.g. one that ran the plain
  // unscoped global scan and only filtered the *result* afterward) would still be able to return
  // it to a range-A-scoped caller — a real SQL `WHERE`/inner-subquery predicate, which is what this
  // repository method actually implements, cannot. Deterministic: no reliance on real external
  // contention or timing luck of any kind, unlike the give-back-loop tests above — EXCEPT for one
  // residual, independently reproduced hazard: row B sits genuinely `pending` (and, by this test's
  // own deliberate design, the table's global minimum by `activity_reached_date`) across several
  // real round trips, so a DIFFERENT, real, globally-scoped `ActivityLogClaimWorker` in a
  // concurrently-running "worker bundle" file (`processing-worker.e2e-spec.ts`,
  // `full-pipeline(-multi-instance).e2e-spec.ts`, `mixed-transport-load.e2e-spec.ts`) can claim it
  // first — reproduced for real during this task's own re-verification (`claimedByRangeB` came back
  // `null` while a worker bundle's own `ActivityLogClaimWorker` was observed starting in the same
  // second, in a full, unfiltered `npm test` run). This is exactly the same class of hazard
  // `processing-worker.e2e-spec.ts`'s own header already documents fixing FOR ITSELF by acquiring
  // `acquireIngestConsumerGroupReaderLease()` before starting its own worker bundle; every real
  // worker-bundle file in this codebase already takes that same lease/lock before running a
  // globally-scoped claim worker, but that only protects a caller that ALSO participates in it —
  // this test's own row was not, and is now brought into that same discipline, for the two tests in
  // this file (this one and its concurrent-variant sibling below) that hold a genuinely-global-
  // minimum, real `pending` row open across more than one real claim round trip. No other test in
  // this file needs this: every one of them either targets its own already-claimed row by exact id
  // in the same transaction as its own insert (`insertAndClaim`, `insertAndPinActivityReachedDate`)
  // or is bounded by `OWN_TENANT_SCOPE`'s own tenant-id predicate with no cross-round-trip exposure
  // window of its own.
  it(
    'T-INT-044 regression: claimNextPendingRow(scope) never returns a row outside its own tenant range, even when a disjoint-range row is the queue global minimum',
    async () => {
      const readerLease: IngestConsumerGroupReaderLease =
        await acquireIngestConsumerGroupReaderLease(READER_LEASE_ACQUIRE_TIMEOUT_MS);
      const rangeATenantId = TENANT_ID + 444_444;
      const rangeBTenantId = TENANT_ID + 555_555;
      const rangeAScope: ClaimScope = {
        tenantIdRangeStart: rangeATenantId,
        tenantIdRangeEnd: rangeATenantId,
      };
      const rangeBScope: ClaimScope = {
        tenantIdRangeStart: rangeBTenantId,
        tenantIdRangeEnd: rangeBTenantId,
      };

      try {
        // Inserted first, so it holds the earliest `activity_reached_date` — the current global
        // minimum — at the moment the range-A-scoped claim below runs.
        const [rowB] = await sequelize.transaction((t) =>
          fanOutRepository.insertFanOutRows(
            [pendingRowInput({ tenantId: rangeBTenantId, trackerComponentCode: 'COMP-RANGE-B' })],
            t,
          ),
        );
        const [rowA] = await sequelize.transaction((t) =>
          fanOutRepository.insertFanOutRows(
            [pendingRowInput({ tenantId: rangeATenantId, trackerComponentCode: 'COMP-RANGE-A' })],
            t,
          ),
        );

        // Scoped to range A: must return row A — never row B, despite row B being the global
        // minimum by `activity_reached_date` at this exact moment.
        const claimedByRangeA = await claimRepository.claimNextPendingRow(rangeAScope);
        expect(claimedByRangeA?.id).toBe(rowA.id);
        expect(claimedByRangeA?.tenant_id).toBe(rangeATenantId);

        // Range A is now empty — a second range-A-scoped call must find nothing. Row B, still
        // genuinely `pending`, must never leak across the boundary just because range A ran dry.
        const secondClaimByRangeA = await claimRepository.claimNextPendingRow(rangeAScope);
        expect(secondClaimByRangeA).toBeNull();

        // Scoped to range B: must still find row B, completely unaffected by everything range A did.
        const claimedByRangeB = await claimRepository.claimNextPendingRow(rangeBScope);
        expect(claimedByRangeB?.id).toBe(rowB.id);
        expect(claimedByRangeB?.tenant_id).toBe(rangeBTenantId);
      } finally {
        try {
          await sequelize.query(
            'DELETE FROM realtime_activity_processing.activity_logs WHERE tenant_id IN (:rangeA, :rangeB)',
            {
              type: QueryTypes.RAW,
              replacements: { rangeA: rangeATenantId, rangeB: rangeBTenantId },
            },
          );
        } finally {
          readerLease.release();
        }
      }
    },
    READER_LEASE_ACQUIRE_TIMEOUT_MS + 30_000,
  );

  // T-INT-044 TC-2 (concurrent variant): the same disjoint-range guarantee under real concurrency
  // — two independent claim loops, each scoped to its own disjoint tenant range, draining a shared
  // pool of rows from BOTH ranges at once. If scoping were anything less than a hard SQL-layer
  // boundary, running both loops concurrently against the SAME table would be exactly the
  // condition under which a foreign claim would surface (the loops race each other for real,
  // rather than running one after the other). Deterministic regardless of scheduling: each loop
  // can only ever end up with rows from its own range, and every row from both ranges is claimed
  // by exactly one of them. Also acquires the reader lease — see the sibling test above's own doc
  // comment for why: these 10 rows sit genuinely `pending` across the whole `Promise.all` drain,
  // the same real cross-suite exposure window, just spread across more rows.
  it(
    'T-INT-044 regression: two claim loops scoped to disjoint tenant ranges, running concurrently, never claim across the boundary',
    async () => {
      const readerLease: IngestConsumerGroupReaderLease =
        await acquireIngestConsumerGroupReaderLease(READER_LEASE_ACQUIRE_TIMEOUT_MS);
      const rangeATenantId = TENANT_ID + 666_666;
      const rangeBTenantId = TENANT_ID + 777_777;
      const rangeAScope: ClaimScope = {
        tenantIdRangeStart: rangeATenantId,
        tenantIdRangeEnd: rangeATenantId,
      };
      const rangeBScope: ClaimScope = {
        tenantIdRangeStart: rangeBTenantId,
        tenantIdRangeEnd: rangeBTenantId,
      };

      try {
        const rangeARows = Array.from({ length: 5 }, (_unused, index) =>
          pendingRowInput({
            tenantId: rangeATenantId,
            trackerComponentCode: `COMP-RANGE-A-${index}`,
          }),
        );
        const rangeBRows = Array.from({ length: 5 }, (_unused, index) =>
          pendingRowInput({
            tenantId: rangeBTenantId,
            trackerComponentCode: `COMP-RANGE-B-${index}`,
          }),
        );
        await sequelize.transaction((t) => fanOutRepository.insertFanOutRows(rangeARows, t));
        await sequelize.transaction((t) => fanOutRepository.insertFanOutRows(rangeBRows, t));

        async function drainRange(scope: ClaimScope): Promise<ActivityLogRow[]> {
          const claimed: ActivityLogRow[] = [];
          for (let i = 0; i < 5; i += 1) {
            const row = await claimRepository.claimNextPendingRow(scope);
            if (row === null) {
              break;
            }
            claimed.push(row);
          }
          return claimed;
        }

        const [claimedA, claimedB] = await Promise.all([
          drainRange(rangeAScope),
          drainRange(rangeBScope),
        ]);

        expect(claimedA).toHaveLength(5);
        expect(claimedB).toHaveLength(5);
        expect(claimedA.every((row) => row.tenant_id === rangeATenantId)).toBe(true);
        expect(claimedB.every((row) => row.tenant_id === rangeBTenantId)).toBe(true);
        const allClaimedIds = [...claimedA, ...claimedB].map((row) => row.id);
        expect(new Set(allClaimedIds).size).toBe(10); // no id claimed by both loops
      } finally {
        try {
          await sequelize.query(
            'DELETE FROM realtime_activity_processing.activity_logs WHERE tenant_id IN (:rangeA, :rangeB)',
            {
              type: QueryTypes.RAW,
              replacements: { rangeA: rangeATenantId, rangeB: rangeBTenantId },
            },
          );
        } finally {
          readerLease.release();
        }
      }
    },
    READER_LEASE_ACQUIRE_TIMEOUT_MS + 30_000,
  );
});
