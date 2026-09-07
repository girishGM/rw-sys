/**
 * T-RR-020 — `ClaimWorkerService`'s own poll-loop lifecycle. The claim SQL's real correctness
 * (exclusivity, index usage, rollback safety) is `reward-redemption-entry-claim.repository.spec.ts`'s
 * job — this file uses a fake repository for the lifecycle/scheduling unit tests, and only the
 * final `describe` block below exercises the real repository against the real local Postgres 16
 * server, as this task's own verification step 2 requires ("start the worker ... watch it drain
 * the queue").
 *
 * T-RR-048 (defect fix): that final `describe` block starts a REAL, actively-polling
 * `ClaimWorkerService` (20ms poll interval) against the real, shared, un-tenant-scoped
 * `reward_redemption_entry` table (`05-PROCESSING-PIPELINE.md` §3 — one global work queue, by
 * design, and correctly not to be changed for production). Jest runs every other real-Postgres
 * spec file (`reward-redemption-entry-claim.repository.spec.ts`, `test/database/reward-redemption-
 * entry.migration.spec.ts`, `test/modules/reward-ingestion/**`, ...) as its own concurrently
 * scheduled process against that exact same table, so an unmodified real worker here will happily
 * claim (and permanently flip to `processing`) a `received`/`retrying` fixture row that belongs to
 * one of those other files, out from under their own assertions — this was reproduced and root-
 * caused as the actual cause of T-RR-048. `TenantScopedClaimRepositoryForTest` below contains the
 * blast radius: it lets this describe block's own worker keep only rows carrying this describe
 * block's own `TENANT_ID`, and immediately gives back (with a bumped `created_at`, so it moves to
 * the back of the claim query's own `ORDER BY created_at` — the exact fix `realtime-activity-
 * processing-service`'s own T-RAP-047 already proved for its own analogous claim-worker test,
 * without which a released row that happens to still be the global minimum gets reclaimed and
 * released over and over instead of the drain ever finishing) anything that isn't. This is a
 * test-only concern layered in front of the real repository, not a change to the production claim
 * SQL or to `ClaimWorkerService` itself, which must both stay global.
 *
 * T-RR-052 (defect fix — this recurred under plain parallel `npm test` even with T-RR-048 done):
 * the give-back above is a *separate* statement issued after the real repository's own
 * `claimNext()` transaction already committed `status = 'processing'` — an unavoidable (from a
 * test file, without touching that production method) window during which a *different*,
 * concurrently-running real-Postgres file (`reward-redemption-entry-claim.repository.spec.ts`,
 * which polls this exact same table) can claim one of *this* file's own fixture rows and, for a
 * moment, leave it sitting in `processing` before its own give-back reaction flips it back to
 * `received` — or, reproduced directly the other way, that other file's own TC-4 can run out of
 * its own bounded give-back budget under this file's fixture volume and permanently strand one of
 * *this* file's rows in `processing` instead of merely delaying it (see that file's own header for
 * its half of this same fix). `npx jest --runInBand` never hits either, because nothing else is
 * ever running at the same moment as this file. `CROSS_FILE_CLAIM_TEST_MUTEX_KEY` below is a real
 * session-level Postgres advisory lock, held for this describe block's entire lifetime, that fully
 * serializes this file's own claim activity against that file's own claim activity — the two files
 * simply take turns owning the shared table, rather than either one trying to make an inherently
 * racy shared-queue observation merely less likely to be caught mid-flight.
 */
const CROSS_FILE_CLAIM_TEST_MUTEX_KEY = 52_020_021; // must match the other file's copy exactly
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import {
  ClaimWorkerRuntimeConfig,
  ClaimWorkerService,
} from '@/modules/processing/claim-worker.service';
import { RewardRedemptionEntryClaimRepository } from '@/modules/processing/reward-redemption-entry-claim.repository';
import type { RedemptionProcessingOrchestrator } from '@/modules/processing/redemption-processing-orchestrator.service';
import { createMigrationConnection } from '@/database/migration-connection';
import type { Config } from '@/config/config.schema';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';
import {
  InstrumentedConnector,
  buildOrchestrator,
  buildStateMachine,
} from './fixtures/concurrent-workers.harness';

/** Polls `predicate` with real timers until it's true or `timeoutMs` elapses. Accepts a
 * synchronous or async predicate so DB-backed conditions can be checked directly. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function buildRow(overrides: Partial<RewardRedemptionEntryRow> = {}): RewardRedemptionEntryRow {
  return {
    id: randomUUID(),
    correlation_id: randomUUID(),
    tenant_id: 1,
    customer_id_encrypted: 'x',
    customer_id_hash: 'x',
    customer_id_type: 'EMAIL',
    activity_performed_date: new Date(),
    transaction_type: null,
    activity_code: null,
    activity_type: 'PURCHASE',
    activity_category: 'SPEND',
    activity_value: '10',
    activity_value_unit: 'USD',
    channel: 'WEB',
    activity_performed_env: 'PROD',
    activity_name: 'fixture',
    campaign_code: 'CAMP1',
    tracker_code: 'TRK1',
    tracker_component_code: 'COMP1',
    merchant_code: null,
    reward_code: 'RWD1',
    reward_category: 'CASHBACK',
    reward_value: '5',
    reward_value_unit: 'USD',
    reward_entry_date: new Date(),
    completion_cycle: 1,
    reward_processed_env: 'development',
    country_code: null,
    tenant_code: null,
    ingestion_channel: 'REST',
    status: 'processing',
    retry_count: 0,
    next_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    last_attempted_at: null,
    external_system_code: null,
    external_reference_id: null,
    redeemed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('T-RR-020 — ClaimWorkerService (unit, fake repository)', () => {
  let claimNext: jest.Mock<Promise<RewardRedemptionEntryRow | null>, []>;
  // T-RR-058: a fake orchestrator, same "fake satisfies only the methods actually called" idiom
  // `claimNext` above already uses — this describe block's own tests are about the poll loop's
  // scheduling behavior, not the orchestrator's own logic (that's
  // `redemption-processing-orchestrator.service.spec.ts`'s job), so nothing here needs a real one.
  let processClaimedEntry: jest.Mock<Promise<RewardRedemptionEntryRow>, [RewardRedemptionEntryRow]>;
  let service: ClaimWorkerService;

  function build(config: ClaimWorkerRuntimeConfig): void {
    claimNext = jest.fn();
    processClaimedEntry = jest.fn(async (entry: RewardRedemptionEntryRow) => entry);
    const repository = { claimNext } as unknown as RewardRedemptionEntryClaimRepository;
    const orchestrator = {
      processClaimedEntry,
    } as unknown as RedemptionProcessingOrchestrator;
    service = new ClaimWorkerService(repository, config, orchestrator);
  }

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('does not poll at all when `enabled` is false', async () => {
    build({ enabled: false, pollIntervalMs: 10 });

    service.onApplicationBootstrap();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(claimNext).not.toHaveBeenCalled();
  });

  it('loops again immediately after a successful claim, without waiting out the poll interval', async () => {
    // A deliberately huge interval: if the loop incorrectly slept between successful claims,
    // this test would time out waiting for the 4th call.
    build({ enabled: true, pollIntervalMs: 100_000 });
    let calls = 0;
    claimNext.mockImplementation(async () => {
      calls += 1;
      return calls <= 3 ? buildRow({ id: `row-${calls}` }) : null;
    });

    service.onApplicationBootstrap();
    await waitFor(() => calls >= 4);

    expect(calls).toBeGreaterThanOrEqual(4);
  });

  // T-RR-058 regression (TC-1/TC-3 of that task's own test table): reproduces the actual reported
  // defect directly at the unit level — before the fix, `pollLoop` stored `claimed` in a local
  // variable and never called anything else with it, so `processClaimedEntry` was never invoked at
  // all. Proven to fail on the pre-fix code: temporarily removing the `orchestrator.
  // processClaimedEntry(claimed)` call in `claim-worker.service.ts` and re-running this exact test
  // left `processClaimedEntry` uncalled (`toHaveBeenCalledTimes(0)`) — see this task's completion
  // report for the observed red run.
  it('T-RR-058 regression: hands a successfully claimed row to the orchestrator', async () => {
    build({ enabled: true, pollIntervalMs: 100_000 });
    const row = buildRow({ id: 'claimed-row' });
    claimNext.mockResolvedValueOnce(row).mockResolvedValue(null);

    service.onApplicationBootstrap();
    await waitFor(() => processClaimedEntry.mock.calls.length >= 1);

    expect(processClaimedEntry).toHaveBeenCalledTimes(1);
    expect(processClaimedEntry).toHaveBeenCalledWith(row);
  });

  it('a rejected processClaimedEntry does not crash the loop — it keeps polling immediately', async () => {
    build({ enabled: true, pollIntervalMs: 100_000 });
    let calls = 0;
    claimNext.mockImplementation(async () => {
      calls += 1;
      return calls <= 1 ? buildRow({ id: `row-${calls}` }) : null;
    });
    processClaimedEntry.mockRejectedValueOnce(new Error('simulated processing failure'));

    service.onApplicationBootstrap();
    // The loop must not stall waiting on the (huge) poll interval after a failed processing
    // attempt — it should immediately claim again, exactly as it does after a successful one.
    await waitFor(() => calls >= 2);

    expect(processClaimedEntry).toHaveBeenCalledTimes(1);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('waits the configured poll interval after an empty poll before trying again', async () => {
    build({ enabled: true, pollIntervalMs: 200 });
    claimNext.mockResolvedValue(null);

    service.onApplicationBootstrap();
    await waitFor(() => claimNext.mock.calls.length >= 1);
    const firstCallCount = claimNext.mock.calls.length;
    // Comfortably less than the 200ms interval — the count must not have advanced yet.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(claimNext.mock.calls.length).toBe(firstCallCount);

    await waitFor(() => claimNext.mock.calls.length > firstCallCount, 2000);
  });

  it('a rejected claimNext does not crash the loop — it keeps polling after the interval', async () => {
    build({ enabled: true, pollIntervalMs: 20 });
    claimNext
      .mockRejectedValueOnce(new Error('simulated transient failure'))
      .mockResolvedValue(null);

    service.onApplicationBootstrap();

    await waitFor(() => claimNext.mock.calls.length >= 2, 2000);
    expect(claimNext.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('onModuleDestroy stops the loop — no further claimNext calls once it resolves', async () => {
    build({ enabled: true, pollIntervalMs: 10 });
    claimNext.mockResolvedValue(null);

    service.onApplicationBootstrap();
    await waitFor(() => claimNext.mock.calls.length >= 1);

    await service.onModuleDestroy();
    const countAtStop = claimNext.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(claimNext.mock.calls.length).toBe(countAtStop);
  });
});

/**
 * T-RR-048. Decorates the real repository so a REAL, actively-polling `ClaimWorkerService`
 * started against it only ever keeps a claimed row that belongs to `tenantId` — this describe
 * block's own fixtures — and immediately gives back anything else (see this file's own header for
 * the full root-cause/rationale). `ClaimWorkerService`'s own constructor only ever calls
 * `claimNext()` on whatever it's given (`claim-worker.service.ts`), so satisfying that one method
 * is sufficient; the cast to `RewardRedemptionEntryClaimRepository` below is the same "fake
 * satisfies only the methods actually called" idiom the fake-repository describe block above
 * already uses (R2 — no `any`, no unchecked cast needed at either call site since the shape is
 * fully typed).
 */
class TenantScopedClaimRepositoryForTest {
  constructor(
    private readonly real: RewardRedemptionEntryClaimRepository,
    private readonly migrationDb: Sequelize,
    private readonly tenantId: number,
  ) {}

  async claimNext(): Promise<RewardRedemptionEntryRow | null> {
    const claimed = await this.real.claimNext();
    if (!claimed || claimed.tenant_id === this.tenantId) {
      return claimed;
    }
    // Give back a foreign row immediately rather than leaving it stuck in `processing` forever —
    // bumping `created_at` too (not just `status`) so it moves to the back of the claim query's
    // own `ORDER BY created_at`, the same fix T-RAP-047 already proved prevents a released row
    // that's still the global minimum from being reclaimed-and-released in a livelock instead of
    // this loop ever finishing its own drain.
    await this.migrationDb.query(
      `UPDATE reward_redemption.reward_redemption_entry
         SET status = 'received', updated_at = now(), created_at = now()
       WHERE id = :id`,
      { type: QueryTypes.RAW, replacements: { id: claimed.id } },
    );
    return null;
  }
}

/**
 * T-RR-058. This describe block's own two existing tests are about the claim SQL's exclusivity and
 * tenant containment (T-RR-020/T-RR-048's own scope) — not about what happens to a row *after* it
 * is claimed, which is `RedemptionProcessingOrchestrator`'s own job (T-RR-024) and is proven for
 * real by the dedicated regression test below instead. Supplying this no-op keeps those two
 * existing tests' own assertions ("drains to `processing`", "a foreign row is given back") exactly
 * as they were before this task (TC-4 — adjacent behaviour unchanged), since a claimed row here is
 * never driven any further than `processing`, exactly as it wasn't before this fix either.
 */
class NoopOrchestratorForTest {
  async processClaimedEntry(entry: RewardRedemptionEntryRow): Promise<RewardRedemptionEntryRow> {
    return entry;
  }
}

describe('T-RR-020 — ClaimWorkerService (real Postgres, verification step 2)', () => {
  const TENANT_ID = 930_000 + Math.floor(Math.random() * 69_999);
  let migrationDb: Sequelize;
  let repository: RewardRedemptionEntryClaimRepository;
  let scopedRepository: RewardRedemptionEntryClaimRepository;
  let service: ClaimWorkerService;
  // T-RR-052: a dedicated, single connection holding the cross-file mutex for this describe
  // block's entire lifetime — a session-level advisory lock is tied to the specific connection
  // that acquired it, so this must be one `Client`, never a pooled `Sequelize` instance that could
  // route the lock/unlock calls to two different underlying connections.
  let mutexClient: Client;

  function realDbConfigService(): ConfigService<Config, true> {
    const values: Partial<Config> = {
      DB_HOST: process.env.DB_HOST,
      DB_PORT: Number(process.env.DB_PORT),
      DB_NAME: process.env.DB_NAME,
      DB_SSL: process.env.DB_SSL === 'true',
      DB_APP_USERNAME: process.env.DB_APP_USERNAME,
      DB_APP_PASSWORD: process.env.DB_APP_PASSWORD,
    } as Partial<Config>;
    return {
      get: ((key: keyof Config) => values[key]) as ConfigService<Config, true>['get'],
    } as ConfigService<Config, true>;
  }

  beforeAll(async () => {
    // T-RR-052: acquire the cross-file mutex FIRST, before any fixture or claim activity in this
    // file starts — see `CROSS_FILE_CLAIM_TEST_MUTEX_KEY`'s own comment. This blocks here until
    // `reward-redemption-entry-claim.repository.spec.ts` (if it got there first) releases its own
    // copy of the same lock in its own `afterAll`.
    const rawConfig = realDbConfigService();
    mutexClient = new Client({
      host: rawConfig.get('DB_HOST', { infer: true }),
      port: rawConfig.get('DB_PORT', { infer: true }),
      database: rawConfig.get('DB_NAME', { infer: true }),
      user: rawConfig.get('DB_APP_USERNAME', { infer: true }),
      password: rawConfig.get('DB_APP_PASSWORD', { infer: true }),
    });
    await mutexClient.connect();
    await mutexClient.query('SELECT pg_advisory_lock($1::bigint)', [
      CROSS_FILE_CLAIM_TEST_MUTEX_KEY,
    ]);

    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
    repository = new RewardRedemptionEntryClaimRepository(realDbConfigService());
    scopedRepository = new TenantScopedClaimRepositoryForTest(
      repository,
      migrationDb,
      TENANT_ID,
    ) as unknown as RewardRedemptionEntryClaimRepository;
    // T-RR-052: `beforeAll` needs its OWN generous timeout here — reproduced directly, this hook
    // can legitimately block on `pg_advisory_lock` above for far longer than Jest's own 5000ms
    // default hook timeout while `reward-redemption-entry-claim.repository.spec.ts`'s own
    // real-Postgres describe block (several tests, each with its own up-to-90s bound) still holds
    // the lock, especially under heavy real-world contention (this project's own concurrently
    // running orchestrator can dispatch another `npm test` at the same time). Without this, Jest
    // throws "Exceeded timeout of 5000 ms for a hook" on the mutex wait itself, which looks like
    // (but is not) a deadlock.
  }, 300_000);

  afterAll(async () => {
    // T-RR-058: `external_system_call_log` rows written by the new regression test below
    // (`markDispatchedExternal`, via a real `RedemptionStateMachineService`) reference
    // `reward_redemption_entry.id` via a `NOT NULL REFERENCES` foreign key
    // (`013_create_external_system_call_log.ts`) with no `ON DELETE CASCADE` — every other test in
    // this describe block only ever leaves a row at `processing`, so this FK was never exercised
    // here before. Deleted first so the entry-table delete below doesn't violate it.
    await migrationDb.query(
      `DELETE FROM reward_redemption.external_system_call_log
         WHERE reward_entry_id IN (
           SELECT id FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id
         )`,
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await migrationDb.query(
      'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await migrationDb.close();
    // The repository's own `pg.Pool` (T-RR-020) — never closed otherwise, which is exactly the
    // "worker process has failed to exit gracefully" leak Jest warns about once several spec
    // files each open one of these and none of them close it.
    await repository.onModuleDestroy();
    // T-RR-052: release the mutex only after every other real-DB cleanup step above has finished,
    // so the sibling file can't start its own claim activity while this file's own teardown is
    // still touching the shared table.
    await mutexClient.query('SELECT pg_advisory_unlock($1::bigint)', [
      CROSS_FILE_CLAIM_TEST_MUTEX_KEY,
    ]);
    await mutexClient.end();
    // T-RR-052: same reasoning as `beforeAll`'s own extended timeout — the DELETE/close/destroy
    // steps above are ordinarily fast, but this file's own real-Postgres tests can each run up to
    // 90s and this hook runs right after the last of them under whatever real-world load was
    // already in play, so it should not be left to inherit Jest's 5000ms default either.
  }, 60_000);

  afterEach(async () => {
    await service?.onModuleDestroy();
  });

  it('drains a real seeded queue to `processing`, with no duplicates, within a bounded time', async () => {
    const ROW_COUNT = 30;
    const seededIds: string[] = [];
    for (let i = 0; i < ROW_COUNT; i += 1) {
      const [row] = await migrationDb.query<{ id: string }>(
        `INSERT INTO reward_redemption.reward_redemption_entry
           (id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash,
            customer_id_type, activity_performed_date, activity_type, activity_category,
            activity_value, activity_value_unit, channel, activity_performed_env, activity_name,
            campaign_code, tracker_code, tracker_component_code, reward_code, reward_category,
            reward_value, reward_value_unit, reward_entry_date, reward_processed_env,
            ingestion_channel, status, next_attempt_at)
         VALUES (gen_random_uuid(), gen_random_uuid(), :tenant_id, 'x', :hash, 'EMAIL', now(),
           'PURCHASE', 'SPEND', 10, 'USD', 'WEB', 'PROD', 't-rr-020 worker drain fixture',
           'CAMP1', 'TRK1', 'COMP1', 'RWD1', 'CASHBACK', 5, 'USD', now(), 'development', 'REST',
           'received', NULL)
         RETURNING id`,
        {
          type: QueryTypes.SELECT,
          replacements: { tenant_id: TENANT_ID, hash: `hash-${i}-${randomUUID()}` },
        },
      );
      seededIds.push(row.id);
    }

    // T-RR-048: scoped, not the bare `repository` — see this file's own header and
    // `TenantScopedClaimRepositoryForTest`'s doc comment for why an unscoped real worker here
    // would be unsafe against every other concurrently-running real-Postgres spec file.
    service = new ClaimWorkerService(
      scopedRepository,
      { enabled: true, pollIntervalMs: 20 },
      new NoopOrchestratorForTest() as unknown as ConstructorParameters<
        typeof ClaimWorkerService
      >[2],
    );
    service.onApplicationBootstrap();

    // T-RR-048: captures the *same* row snapshot the wait condition itself observed, rather than
    // re-querying separately afterwards. A sibling real-DB spec file's own claim loop (e.g.
    // `reward-redemption-entry-claim.repository.spec.ts`'s TC-3/TC-5, which now also gives back
    // rows it doesn't recognize — this task's own fix) can legitimately claim one of *this* test's
    // own rows before this worker's next poll reclaims it, and give it back a moment later; a
    // second, separate `SELECT` run after `waitFor` resolves could observe that row mid-flight
    // back in `received`, even though the single instant `waitFor`'s own predicate last checked
    // was genuinely all-`processing`. Reusing that exact snapshot for the assertions below removes
    // that gap entirely.
    let drainedRows: RewardRedemptionEntryRow[] = [];
    await waitFor(async () => {
      const rows = await migrationDb.query<RewardRedemptionEntryRow>(
        `SELECT id, status FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id`,
        { type: QueryTypes.SELECT, replacements: { tenant_id: TENANT_ID } },
      );
      const done = rows.length === ROW_COUNT && rows.every((row) => row.status === 'processing');
      if (done) {
        drainedRows = rows;
      }
      return done;
    }, 10_000);

    const rows = drainedRows;
    expect(rows).toHaveLength(ROW_COUNT);
    expect(rows.every((row) => row.status === 'processing')).toBe(true);
    expect(new Set(rows.map((row) => row.id)).size).toBe(ROW_COUNT);
    expect(seededIds.every((id) => rows.some((row) => row.id === id))).toBe(true);
    // T-RR-048: an explicit Jest timeout comfortably longer than `waitFor`'s own internal 10s
    // deadline above (plus setup/query overhead) — this test has no reason to inherit Jest's 5s
    // default, and under real load from every other concurrently-running real-Postgres spec file
    // hammering the same shared table, 30 sequential inserts plus a 20ms-interval drain can
    // legitimately take longer than that default allows for reasons that have nothing to do with
    // this test's own correctness (observed directly: a real timeout under `test/processing`'s own
    // two-file concurrent run, not a hypothetical).
  }, 30_000);

  // T-RR-048 regression (TC-3 of that task's own test table): reproduces the actual reported
  // defect directly — a real, actively-polling worker started against the BARE (unscoped)
  // repository claims a `received` row belonging to a different tenant (standing in for another
  // concurrently-running spec file's own fixture) and leaves it stuck in `processing` forever.
  // Proven to fail on the pre-fix code by running this exact assertion against `repository`
  // (bare) instead of `scopedRepository`: the foreign row's status came back `processing`, never
  // given back — see this task's completion report for the observed red run.
  it('T-RR-048 regression: a scoped worker gives back a foreign-tenant row instead of leaving it stuck in `processing`', async () => {
    const foreignTenantId = TENANT_ID - 1;
    // Backdated to the year 2000 — the most attractive possible target for the claim query's own
    // `ORDER BY created_at`, i.e. the worst case: if containment were broken, this row would be
    // claimed before this test's own (`now()`-dated) row below.
    const [foreignRow] = await migrationDb.query<{ id: string }>(
      `INSERT INTO reward_redemption.reward_redemption_entry
         (id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash,
          customer_id_type, activity_performed_date, activity_type, activity_category,
          activity_value, activity_value_unit, channel, activity_performed_env, activity_name,
          campaign_code, tracker_code, tracker_component_code, reward_code, reward_category,
          reward_value, reward_value_unit, reward_entry_date, reward_processed_env,
          ingestion_channel, status, next_attempt_at, created_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), :tenant_id, 'x', :hash, 'EMAIL', now(),
         'PURCHASE', 'SPEND', 10, 'USD', 'WEB', 'PROD', 't-rr-048 foreign fixture',
         'CAMP1', 'TRK1', 'COMP1', 'RWD1', 'CASHBACK', 5, 'USD', now(), 'development', 'REST',
         'received', NULL, '2000-01-01T00:00:00.000Z')
       RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenant_id: foreignTenantId, hash: `hash-foreign-${randomUUID()}` },
      },
    );

    const [ownRow] = await migrationDb.query<{ id: string }>(
      `INSERT INTO reward_redemption.reward_redemption_entry
         (id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash,
          customer_id_type, activity_performed_date, activity_type, activity_category,
          activity_value, activity_value_unit, channel, activity_performed_env, activity_name,
          campaign_code, tracker_code, tracker_component_code, reward_code, reward_category,
          reward_value, reward_value_unit, reward_entry_date, reward_processed_env,
          ingestion_channel, status, next_attempt_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), :tenant_id, 'x', :hash, 'EMAIL', now(),
         'PURCHASE', 'SPEND', 10, 'USD', 'WEB', 'PROD', 't-rr-048 own fixture',
         'CAMP1', 'TRK1', 'COMP1', 'RWD1', 'CASHBACK', 5, 'USD', now(), 'development', 'REST',
         'received', NULL)
       RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenant_id: TENANT_ID, hash: `hash-own-${randomUUID()}` },
      },
    );

    try {
      service = new ClaimWorkerService(
        scopedRepository,
        { enabled: true, pollIntervalMs: 20 },
        new NoopOrchestratorForTest() as unknown as ConstructorParameters<
          typeof ClaimWorkerService
        >[2],
      );
      service.onApplicationBootstrap();

      await waitFor(async () => {
        const [{ remaining }] = await migrationDb.query<{ remaining: string }>(
          `SELECT count(*)::text AS remaining FROM reward_redemption.reward_redemption_entry
             WHERE tenant_id = :tenant_id AND status IN ('received', 'retrying')`,
          { type: QueryTypes.SELECT, replacements: { tenant_id: TENANT_ID } },
        );
        return remaining === '0';
      }, 10_000);
      // T-RR-048: stop the worker (rather than a fixed sleep) before reading final state. As long
      // as this worker is still running, it keeps re-claiming-and-giving-back the foreign row on
      // every poll (it's the only globally eligible row left once this test's own 30 are drained),
      // so a plain `SELECT` can land in the narrow, genuinely-committed-but-not-yet-given-back
      // `processing` window between those two steps — a real, observed flake, not a defect in the
      // containment itself. `onModuleDestroy()` waits for the current `pollLoop` iteration
      // (including any in-flight `claimNext()` call, which for `TenantScopedClaimRepositoryForTest`
      // always finishes with its own give-back before returning) to fully complete before it
      // resolves, so by the time this line returns the row's state is settled, not mid-flight.
      await service.onModuleDestroy();

      const [own] = await migrationDb.query<RewardRedemptionEntryRow>(
        'SELECT status FROM reward_redemption.reward_redemption_entry WHERE id = :id',
        { type: QueryTypes.SELECT, replacements: { id: ownRow.id } },
      );
      expect(own.status).toBe('processing');

      const [foreign] = await migrationDb.query<RewardRedemptionEntryRow>(
        'SELECT status FROM reward_redemption.reward_redemption_entry WHERE id = :id',
        { type: QueryTypes.SELECT, replacements: { id: foreignRow.id } },
      );
      // The whole point: never left stuck in `processing` — either never claimed at all, or
      // claimed-and-given-back to `received`.
      expect(foreign.status).toBe('received');
    } finally {
      await migrationDb.query(
        'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id',
        { type: QueryTypes.RAW, replacements: { tenant_id: foreignTenantId } },
      );
    }
    // T-RR-048: same reasoning as the previous test's own explicit timeout — comfortably longer
    // than the internal 10s `waitFor` deadline plus setup/teardown overhead under real concurrent
    // load, not Jest's 5s default.
  }, 30_000);

  // T-RR-058 regression (TC-2/TC-3 of that task's own test table) — the actual defect this task
  // fixes, proven end to end against the real, shared Postgres table: a claimed row must not be
  // left stuck in `processing` forever. Uses the real `RewardRedemptionEntryClaimRepository`
  // (tenant-scoped, same containment every other test in this describe block relies on) and a real
  // `RedemptionProcessingOrchestrator`/`RedemptionStateMachineService` (T-RR-025's own
  // `concurrent-workers.harness.ts`, already proven correct by that task's own suite) — only the
  // two cached lookups (campaign/connector-config resolution) are fixed test doubles, the identical
  // scope boundary that harness's own header already documents. Proven to fail on the pre-fix
  // `claim-worker.service.ts` (the orchestrator call commented out): the row's status came back
  // `processing` and `connector.callCountFor(row.id)` was `0` — the connector was never invoked at
  // all — until this `waitFor` timed out; see this task's completion report for the observed red
  // run.
  it('T-RR-058 regression: a claimed row is actually driven to a terminal state by the wired orchestrator', async () => {
    const [row] = await migrationDb.query<{ id: string }>(
      `INSERT INTO reward_redemption.reward_redemption_entry
         (id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash,
          customer_id_type, activity_performed_date, activity_type, activity_category,
          activity_value, activity_value_unit, channel, activity_performed_env, activity_name,
          campaign_code, tracker_code, tracker_component_code, reward_code, reward_category,
          reward_value, reward_value_unit, reward_entry_date, reward_processed_env,
          ingestion_channel, status, next_attempt_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), :tenant_id, 'x', :hash, 'EMAIL', now(),
         'PURCHASE', 'SPEND', 10, 'USD', 'WEB', 'PROD', 't-rr-058 orchestrator-wiring fixture',
         'CAMP1', 'TRK1', 'COMP1', 'RWD1', 'CASHBACK', 5, 'USD', now(), 'development', 'REST',
         'received', NULL)
       RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenant_id: TENANT_ID, hash: `hash-t-rr-058-${randomUUID()}` },
      },
    );

    const connector = new InstrumentedConnector();
    const realStateMachine = buildStateMachine();
    const orchestrator = buildOrchestrator(connector, realStateMachine);

    try {
      service = new ClaimWorkerService(
        scopedRepository,
        { enabled: true, pollIntervalMs: 20 },
        orchestrator,
      );
      service.onApplicationBootstrap();

      await waitFor(async () => {
        const [current] = await migrationDb.query<RewardRedemptionEntryRow>(
          'SELECT status FROM reward_redemption.reward_redemption_entry WHERE id = :id',
          { type: QueryTypes.SELECT, replacements: { id: row.id } },
        );
        return current.status === 'dispatched_external';
      }, 10_000);

      const [final] = await migrationDb.query<RewardRedemptionEntryRow>(
        `SELECT status, external_reference_id, external_system_code
           FROM reward_redemption.reward_redemption_entry WHERE id = :id`,
        { type: QueryTypes.SELECT, replacements: { id: row.id } },
      );
      expect(final.status).toBe('dispatched_external');
      expect(final.external_reference_id).toBeTruthy();
      expect(final.external_system_code).toBeTruthy();
      // The whole point of this task: the orchestrator was actually called, exactly once, with
      // exactly this row — not left uncalled the way the pre-fix `ClaimWorkerService` left it.
      expect(connector.callCountFor(row.id)).toBe(1);
    } finally {
      // `service.onModuleDestroy()` itself is also called by this describe block's own
      // `afterEach` — safe to call twice (idempotent, see `ClaimWorkerService.onModuleDestroy`'s
      // own body). Only `realStateMachine`'s own pool (this test's own, not shared with anything
      // else in this describe block) needs cleanup here.
      await service?.onModuleDestroy();
      await realStateMachine.onModuleDestroy();
    }
    // Same reasoning as this describe block's other real-Postgres tests' own explicit timeouts.
  }, 15_000);
});
