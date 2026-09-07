/**
 * T-RR-025 — Concurrency/load safety: multi-worker claim contention + duplicate entries, against
 * the real local Postgres 16 server (root `CLAUDE.md`), never a mock. Proves `01-DATABASE.md` §12
 * / `05-PROCESSING-PIPELINE.md` §3's three-layer concurrency model end to end — (1) `SKIP LOCKED`
 * (no two workers ever claim the same row), (2) `pg_advisory_xact_lock` (closes the narrow race a
 * redelivered/duplicate arrival racing an in-flight claim of the same id), (3) the primary key on
 * `id` (the last-resort guarantee) — through the *real* claim repository (T-RR-020), state machine
 * (T-RR-021) and orchestrator (T-RR-024), not a mock repository. See
 * `fixtures/concurrent-workers.harness.ts`'s own header for exactly what's real vs. fixed-and-fake
 * in this wiring (only the two portal-feed/connector-config *cache* lookups are fake, never the
 * claim/state-machine/orchestrator layers this task's own Scope section is about), and for why this
 * suite joins `CROSS_FILE_CLAIM_TEST_MUTEX_KEY`.
 *
 * **Scenario C / TC-4's own documented limitation (implementation note 5).** "Multiple simulated
 * separate instances" here means two fully independent `RewardRedemptionEntryClaimRepository`/
 * `RedemptionStateMachineService`/`RedemptionProcessingOrchestrator` sets, each with its own
 * dedicated `pg.Pool`, racing the same real claim SQL against the same real Postgres server — not
 * two separate OS processes (e.g. two `ts-node` child processes). This was evaluated and rejected
 * as disproportionate to this task's own 1.5-agent-day estimate: nothing in §3's own reasoning
 * depends on two instances sharing (or not sharing) a single OS process — the guarantee under test
 * is that Postgres's own row-level locking (`FOR UPDATE SKIP LOCKED`, `pg_advisory_xact_lock`)
 * correctly arbitrates between two independent, uncoordinated connection pools, which two `Pool`
 * objects within one Node process already exercise faithfully (client-side, they share nothing —
 * no in-memory cache, no shared mutex — with each other; only the server's own locking state is
 * ever shared, and that is identical whether the two callers happen to live in one OS process or
 * two). Documented explicitly per this task's own DoD, rather than silently assumed equivalent.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize, QueryTypes } from 'sequelize';
import { Client } from 'pg';
import { createMigrationConnection } from '@/database/migration-connection';
import {
  EncryptionService,
  loadEncryptionKeyMaterial,
} from '@/modules/encryption/encryption.service';
import { LogRedactorService } from '@/modules/encryption/log-redactor.service';
import { RewardIngestionService } from '@/modules/reward-ingestion/reward-ingestion.service';
import { RewardRedemptionEntryRepository } from '@/modules/reward-ingestion/reward-redemption-entry.repository';
import type { RewardEntryIngestDto } from '@/modules/reward-ingestion/reward-entry-ingest.dto';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';
import {
  CROSS_FILE_CLAIM_TEST_MUTEX_KEY,
  realDbConfigService,
  buildClaimRepository,
  buildStateMachine,
  buildOrchestrator,
  InstrumentedConnector,
  successOutcome,
  runWorkerPool,
} from './fixtures/concurrent-workers.harness';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A fresh, well-separated tenant id per test — a 9-digit range nothing else in this service's own
 * test suite draws from (every other real-claim spec file picks a 6-digit range in `9xx_xxx`),
 * plus a monotonically increasing offset, so no two calls in this file's own run can collide with
 * each other either. */
let tenantCounter = 0;
function nextTenantId(): number {
  tenantCounter += 1;
  return 951_000_000 + tenantCounter * 10_000 + Math.floor(Math.random() * 9_000);
}

describe('T-RR-025 — concurrency/load safety (real Postgres, real concurrent claim+process)', () => {
  let migrationDb: Sequelize;
  let mutexClient: Client;
  let ingestionRepo: RewardRedemptionEntryRepository;
  let ingestionService: RewardIngestionService;

  function baseEntryFields(
    tenantId: number,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      id: randomUUID(),
      correlation_id: randomUUID(),
      tenant_id: tenantId,
      customer_id_encrypted: 'ciphertext-placeholder',
      customer_id_hash: `hash-${randomUUID()}`,
      customer_id_type: 'EMAIL',
      activity_performed_date: new Date(),
      transaction_type: null,
      activity_code: 'ACT_CODE',
      activity_type: 'PURCHASE',
      activity_category: 'SPEND',
      activity_value: 10,
      activity_value_unit: 'USD',
      channel: 'WEB',
      activity_performed_env: 'PROD',
      activity_name: 't-rr-025 load-safety fixture',
      campaign_code: 'CAMP1',
      tracker_code: 'TRK1',
      tracker_component_code: 'COMP1',
      merchant_code: null,
      reward_code: 'RWD1',
      reward_category: 'CASHBACK',
      reward_value: 5,
      reward_value_unit: 'USD',
      reward_entry_date: new Date(),
      completion_cycle: 1,
      reward_processed_env: 'development',
      ingestion_channel: 'REST',
      status: 'received',
      next_attempt_at: null,
      ...overrides,
    };
  }

  async function insertEntry(
    tenantId: number,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const f = baseEntryFields(tenantId, overrides);
    const [row] = await migrationDb.query<{ id: string }>(
      `INSERT INTO reward_redemption.reward_redemption_entry
         (id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash, customer_id_type,
          activity_performed_date, transaction_type, activity_code, activity_type,
          activity_category, activity_value, activity_value_unit, channel, activity_performed_env,
          activity_name, campaign_code, tracker_code, tracker_component_code, merchant_code,
          reward_code, reward_category, reward_value, reward_value_unit, reward_entry_date,
          completion_cycle, reward_processed_env, ingestion_channel, status, next_attempt_at)
       VALUES
         (:id, :correlation_id, :tenant_id, :customer_id_encrypted, :customer_id_hash,
          :customer_id_type, :activity_performed_date, :transaction_type, :activity_code,
          :activity_type, :activity_category, :activity_value, :activity_value_unit, :channel,
          :activity_performed_env, :activity_name, :campaign_code, :tracker_code,
          :tracker_component_code, :merchant_code, :reward_code, :reward_category, :reward_value,
          :reward_value_unit, :reward_entry_date, :completion_cycle, :reward_processed_env,
          :ingestion_channel, :status, :next_attempt_at)
       RETURNING id`,
      { type: QueryTypes.SELECT, replacements: f },
    );
    return row.id;
  }

  function buildIngestDto(
    tenantId: number,
    overrides: Partial<RewardEntryIngestDto> = {},
  ): RewardEntryIngestDto {
    return {
      id: randomUUID(),
      correlationId: randomUUID(),
      tenantId,
      customerId: `cust-${randomUUID()}`,
      customerIdType: 'EMAIL',
      activityPerformedDate: new Date(),
      transactionType: null,
      activityCode: 'ACT_CODE',
      activityType: 'PURCHASE',
      activityCategory: 'SPEND',
      activityValue: '10.0000',
      activityValueUnit: 'USD',
      channel: 'WEB',
      activityPerformedEnv: 'PROD',
      activityName: 't-rr-025 load-safety ingest fixture',
      campaignCode: 'CAMP1',
      trackerCode: 'TRK1',
      trackerComponentCode: 'COMP1',
      merchantCode: null,
      rewardCode: 'RWD1',
      rewardCategory: 'CASHBACK',
      rewardValue: '5.0000',
      rewardValueUnit: 'USD',
      rewardEntryDate: new Date(),
      completionCycle: 1,
      ingestionChannel: 'REST',
      ...overrides,
    };
  }

  async function fetchStatus(id: string): Promise<string | undefined> {
    const [row] = await migrationDb.query<{ status: string }>(
      'SELECT status FROM reward_redemption.reward_redemption_entry WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    return row?.status;
  }

  async function countRowsWithId(id: string): Promise<number> {
    const [row] = await migrationDb.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_redemption.reward_redemption_entry WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    return Number(row.count);
  }

  async function fetchTenantRows(tenantId: number): Promise<RewardRedemptionEntryRow[]> {
    return migrationDb.query<RewardRedemptionEntryRow>(
      'SELECT * FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenantId',
      { type: QueryTypes.SELECT, replacements: { tenantId } },
    );
  }

  /** Deletes every row this suite's own fixtures wrote for `tenantId` — the child rows this
   * suite's own successful runs write via `RedemptionStateMachineService.markDispatchedExternal`
   * (`external_system_call_log`, FK'd to `reward_redemption_entry.id`) first, since that foreign
   * key has no `ON DELETE CASCADE` (`013_create_external_system_call_log.ts`) — deleting the
   * parent row first would otherwise violate it. */
  async function cleanupTenant(tenantId: number): Promise<void> {
    await migrationDb.query(
      `DELETE FROM reward_redemption.external_system_call_log
        WHERE reward_entry_id IN (
          SELECT id FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenantId
        )`,
      { type: QueryTypes.RAW, replacements: { tenantId } },
    );
    await migrationDb.query(
      'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId } },
    );
  }

  /** Polls until `predicate` is true, or throws once `timeoutMs` elapses — used to wait for a
   * specific row to reach `processing` before firing a duplicate `ingest()` call at it (Scenario
   * B), the same "wait for the real, persisted state" idiom every real-Postgres spec file in this
   * service already uses rather than a fixed sleep. */
  async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
      }
      await sleep(10);
    }
  }

  beforeAll(async () => {
    // T-RR-052's own pattern: acquire the cross-file mutex FIRST, before any fixture or claim
    // activity in this file starts — see the harness's own header. Blocks here until whichever of
    // `reward-redemption-entry-claim.repository.spec.ts` / `claim-worker.service.spec.ts` got there
    // first releases its own copy of the same lock in its own `afterAll`.
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

    ingestionRepo = new RewardRedemptionEntryRepository(realDbConfigService());
    const encryption = new EncryptionService(loadEncryptionKeyMaterial());
    const logRedactor = new LogRedactorService(encryption);
    ingestionService = new RewardIngestionService(
      ingestionRepo,
      encryption,
      logRedactor,
      realDbConfigService(),
    );
    // Mirrors `claim-worker.service.spec.ts`'s own `beforeAll` timeout reasoning exactly: the
    // mutex wait above can legitimately block for as long as either sibling file's own up-to-90s
    // real-Postgres describe block still holds it.
  }, 300_000);

  afterAll(async () => {
    await ingestionRepo?.onModuleDestroy();
    await migrationDb.close();
    await mutexClient.query('SELECT pg_advisory_unlock($1::bigint)', [
      CROSS_FILE_CLAIM_TEST_MUTEX_KEY,
    ]);
    await mutexClient.end();
  }, 60_000);

  it('TC-1: Scenario A — 50 seeded received rows, 10 concurrent claim workers: exactly 50 claims, no double-claim, no worker error', async () => {
    const tenantId = nextTenantId();
    const seededIds = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      seededIds.add(await insertEntry(tenantId));
    }

    const connector = new InstrumentedConnector();
    const claimRepository = buildClaimRepository();
    const stateMachine = buildStateMachine();
    const orchestrator = buildOrchestrator(connector, stateMachine);
    const processedIds: string[] = [];

    try {
      const { errors } = await runWorkerPool({
        workerCount: 10,
        tenantId,
        claimRepository,
        migrationDb,
        orchestrator,
        isDone: () => processedIds.length >= seededIds.size,
        onProcessed: (row) => processedIds.push(row.id),
        deadlineMs: 60_000,
      });

      expect(errors).toEqual([]);
      // Layer 1 (`SKIP LOCKED`): every row claimed exactly once — never twice, never zero.
      expect(processedIds).toHaveLength(50);
      expect(new Set(processedIds).size).toBe(50);
      expect(new Set(processedIds)).toEqual(seededIds);
      // The connector is the strongest witness of "processed exactly once": a second claim of
      // an already-`processing` row would show up here as a second `redeem()` call.
      expect(connector.idsCalledMoreThanOnce()).toEqual([]);

      const rows = await fetchTenantRows(tenantId);
      expect(rows).toHaveLength(50);
      expect(rows.every((row) => row.status === 'dispatched_external')).toBe(true);
    } finally {
      await claimRepository.onModuleDestroy();
      await stateMachine.onModuleDestroy();
      await cleanupTenant(tenantId);
    }
  }, 90_000);

  it('TC-2: Scenario A, N (workers) > M (rows) — 5 rows, 20 workers: exactly 5 claims, the other 15 attempts cleanly find no eligible row', async () => {
    const tenantId = nextTenantId();
    const seededIds = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      seededIds.add(await insertEntry(tenantId));
    }

    const connector = new InstrumentedConnector();
    const claimRepository = buildClaimRepository();
    const stateMachine = buildStateMachine();
    const orchestrator = buildOrchestrator(connector, stateMachine);
    const processedIds: string[] = [];

    try {
      const { errors } = await runWorkerPool({
        workerCount: 20,
        tenantId,
        claimRepository,
        migrationDb,
        orchestrator,
        isDone: () => processedIds.length >= seededIds.size,
        onProcessed: (row) => processedIds.push(row.id),
        deadlineMs: 45_000,
        idleSleepMs: 10,
      });

      // "no error" (task's own expected result) — an empty/momentarily-empty poll must resolve
      // `null`, never throw (T-RR-020's own claim repository already proves this in isolation;
      // this is the same property proven again under 4x-oversubscribed worker contention).
      expect(errors).toEqual([]);
      expect(processedIds).toHaveLength(5);
      expect(new Set(processedIds)).toEqual(seededIds);
      expect(connector.idsCalledMoreThanOnce()).toEqual([]);
    } finally {
      await claimRepository.onModuleDestroy();
      await stateMachine.onModuleDestroy();
      await cleanupTenant(tenantId);
    }
  }, 60_000);

  it('TC-3: Scenario B — 10 duplicate ingest() calls injected while their rows are actively `processing` in another worker', async () => {
    const tenantId = nextTenantId();
    const DELAY_MS = 400;
    const targetIds = new Set<string>();
    const targetDtos = new Map<string, RewardEntryIngestDto>();

    // 40 plain rows the pool must also drain, so the target rows are genuinely racing against
    // real background claim activity, not the only work available.
    const plainCount = 40;
    for (let i = 0; i < plainCount; i += 1) {
      await insertEntry(tenantId);
    }
    // 10 target rows, seeded via the real ingestion path (T-RR-010) — implementation note 4's
    // own requirement — so the exact same DTO can be replayed as a "redelivery" below.
    for (let i = 0; i < 10; i += 1) {
      const dto = buildIngestDto(tenantId);
      const result = await ingestionService.ingest(dto);
      targetIds.add(result.rewardEntryId);
      targetDtos.set(result.rewardEntryId, dto);
    }

    // The connector artificially delays only a target id's *first* call — giving this test a
    // reliable window, after the row is claimed (`processing`) and before the connector call
    // resolves, in which to fire the duplicate `ingest()` call at it.
    const connector = new InstrumentedConnector((entry, callNumber) => {
      if (targetIds.has(entry.id) && callNumber === 1) {
        return new Promise((resolve) => setTimeout(() => resolve(successOutcome()), DELAY_MS));
      }
      return successOutcome();
    });
    const claimRepository = buildClaimRepository();
    const stateMachine = buildStateMachine();
    const orchestrator = buildOrchestrator(connector, stateMachine);
    const processedIds: string[] = [];
    const totalRows = plainCount + targetIds.size;

    try {
      const poolPromise = runWorkerPool({
        workerCount: 10,
        tenantId,
        claimRepository,
        migrationDb,
        orchestrator,
        isDone: () => processedIds.length >= totalRows,
        onProcessed: (row) => processedIds.push(row.id),
        deadlineMs: 60_000,
      });

      // Concurrently: for every target id, wait until it is actually `processing` (claimed by
      // one of the pool's own workers), then immediately fire the "redelivery" — a second,
      // genuinely concurrent `ingest()` call for the identical id, exercising R6's own
      // short-circuit path while the row is mid-flight.
      const duplicateResults = await Promise.all(
        Array.from(targetIds).map(async (id) => {
          await waitFor(async () => (await fetchStatus(id)) === 'processing', 10_000);
          const dto = targetDtos.get(id);
          if (!dto) {
            throw new Error(`no dto recorded for target id ${id}`);
          }
          const result = await ingestionService.ingest(dto);
          return { id, result };
        }),
      );

      const { errors } = await poolPromise;

      expect(errors).toEqual([]);
      for (const { id, result } of duplicateResults) {
        expect(result.rewardEntryId).toBe(id);
        // Never short-circuits back to `received` — the row was already claimed by the time
        // the duplicate landed (R6: short-circuits to the *current* status, never re-inserts).
        expect(['processing', 'dispatched_external']).toContain(result.status);
      }

      // The actual guarantee this scenario exists to prove: never a second row, never a second
      // claim/process cycle, for any of the 10 targeted ids.
      for (const id of targetIds) {
        expect(await countRowsWithId(id)).toBe(1);
        expect(connector.callCountFor(id)).toBe(1);
      }
      expect(connector.idsCalledMoreThanOnce()).toEqual([]);

      const rows = await fetchTenantRows(tenantId);
      expect(rows).toHaveLength(totalRows);
      expect(rows.every((row) => row.status === 'dispatched_external')).toBe(true);
    } finally {
      await claimRepository.onModuleDestroy();
      await stateMachine.onModuleDestroy();
      await cleanupTenant(tenantId);
    }
  }, 90_000);

  it('TC-4: Scenario C — Scenario A repeated across two simulated separate instances (independent pools): same guarantees hold across instance boundaries', async () => {
    const tenantId = nextTenantId();
    const seededIds = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      seededIds.add(await insertEntry(tenantId));
    }

    // One shared connector stands in for the one real external system both simulated instances
    // would call in production — the property under test is "no id is ever redeemed twice
    // *across* instances", which only a shared observer can prove directly.
    const connector = new InstrumentedConnector();
    const claimRepositoryA = buildClaimRepository(10);
    const stateMachineA = buildStateMachine(10);
    const orchestratorA = buildOrchestrator(connector, stateMachineA);
    const claimRepositoryB = buildClaimRepository(10);
    const stateMachineB = buildStateMachine(10);
    const orchestratorB = buildOrchestrator(connector, stateMachineB);
    const processedIds: string[] = [];
    const isDone = () => processedIds.length >= seededIds.size;

    try {
      const [outcomeA, outcomeB] = await Promise.all([
        runWorkerPool({
          workerCount: 5,
          tenantId,
          claimRepository: claimRepositoryA,
          migrationDb,
          orchestrator: orchestratorA,
          isDone,
          onProcessed: (row) => processedIds.push(row.id),
          deadlineMs: 60_000,
        }),
        runWorkerPool({
          workerCount: 5,
          tenantId,
          claimRepository: claimRepositoryB,
          migrationDb,
          orchestrator: orchestratorB,
          isDone,
          onProcessed: (row) => processedIds.push(row.id),
          deadlineMs: 60_000,
        }),
      ]);

      expect([...outcomeA.errors, ...outcomeB.errors]).toEqual([]);
      expect(processedIds).toHaveLength(40);
      expect(new Set(processedIds)).toEqual(seededIds);
      expect(connector.idsCalledMoreThanOnce()).toEqual([]);

      const rows = await fetchTenantRows(tenantId);
      expect(rows).toHaveLength(40);
      expect(rows.every((row) => row.status === 'dispatched_external')).toBe(true);
    } finally {
      await Promise.all([
        claimRepositoryA.onModuleDestroy(),
        claimRepositoryB.onModuleDestroy(),
        stateMachineA.onModuleDestroy(),
        stateMachineB.onModuleDestroy(),
      ]);
      await cleanupTenant(tenantId);
    }
  }, 90_000);

  it('TC-5 (negative): 200 mixed fresh/duplicate entries, 15 concurrent workers, run to completion — zero duplicate rows, zero doubled connector calls', async () => {
    const tenantId = nextTenantId();
    const freshCount = 150;
    const duplicateCount = 50;

    const dtos: RewardEntryIngestDto[] = Array.from({ length: freshCount }, () =>
      buildIngestDto(tenantId),
    );
    // 200 "arrivals" total: 150 fresh + 50 redeliveries of a random subset of those same 150
    // ids, all fired concurrently — both a realistic mixed batch (task's own wording) and a
    // direct R6 race at the ingestion layer itself, on top of this suite's own claim-layer race.
    const duplicateDtos: RewardEntryIngestDto[] = Array.from(
      { length: duplicateCount },
      () => dtos[Math.floor(Math.random() * dtos.length)],
    );

    await Promise.all([...dtos, ...duplicateDtos].map((dto) => ingestionService.ingest(dto)));

    const connector = new InstrumentedConnector();
    const claimRepository = buildClaimRepository();
    const stateMachine = buildStateMachine();
    const orchestrator = buildOrchestrator(connector, stateMachine);
    const processedIds: string[] = [];

    try {
      const { errors } = await runWorkerPool({
        workerCount: 15,
        tenantId,
        claimRepository,
        migrationDb,
        orchestrator,
        isDone: () => processedIds.length >= freshCount,
        onProcessed: (row) => processedIds.push(row.id),
        deadlineMs: 90_000,
      });

      expect(errors).toEqual([]);
      expect(processedIds).toHaveLength(freshCount);
      expect(new Set(processedIds).size).toBe(freshCount);
      expect(connector.idsCalledMoreThanOnce()).toEqual([]);

      // The literal invariant this task's own Verification step 4 asks for — structurally
      // guaranteed by the primary key on `id` regardless of any application-level defect, so
      // this is corroborating evidence, not this scenario's own primary proof (that's the
      // connector call-count assertion above); still asserted here, scoped to this test's own
      // tenant, per the task file's own wording.
      const duplicateGroups = await migrationDb.query<{ id: string; count: string }>(
        `SELECT id, count(*)::text AS count
             FROM reward_redemption.reward_redemption_entry
            WHERE tenant_id = :tenantId
            GROUP BY id
           HAVING count(*) > 1`,
        { type: QueryTypes.SELECT, replacements: { tenantId } },
      );
      expect(duplicateGroups).toEqual([]);

      const rows = await fetchTenantRows(tenantId);
      expect(rows).toHaveLength(freshCount);
      expect(rows.every((row) => row.status === 'dispatched_external')).toBe(true);
    } finally {
      await claimRepository.onModuleDestroy();
      await stateMachine.onModuleDestroy();
      await cleanupTenant(tenantId);
    }
  }, 120_000);
});
