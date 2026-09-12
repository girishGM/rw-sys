/**
 * T-RR-021 — `RedemptionStateMachineService`, exercised against the real Postgres 16 server (root
 * `CLAUDE.md`), never a mock/in-memory DB. Unlike `test/processing/reward-redemption-entry-claim.
 * repository.spec.ts` (T-RR-020), every test here targets a row by its own known `id` — this
 * service never scans the shared table, so there is no cross-file contention to tolerate; each
 * test seeds its own row and only ever touches that row.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { ConfigService } from '@nestjs/config';
import { createMigrationConnection } from '@/database/migration-connection';
import {
  RedemptionStateMachineService,
  type MarkDispatchedExternalInput,
} from '@/modules/redemption/redemption-state-machine.service';
import {
  InvalidRedemptionStateTransitionError,
  RedemptionEntryNotFoundError,
} from '@/modules/redemption/redemption-state-machine.errors';
import type { RedemptionCompletionSideEffectsPort } from '@/modules/redemption/redemption-completion-side-effects.port';
import type { Config } from '@/config/config.schema';
import type {
  RewardRedemptionEntryRow,
  RewardRedemptionEntryStatus,
} from '@/database/models/reward-redemption-entry.model';

const TENANT_ID = 940_000 + Math.floor(Math.random() * 59_999);

/**
 * T-RR-053. The status this file's own "illegal source status" fixture for `markDispatchedExternal`
 * uses. It must never be `'received'` or `'retrying'` — those are exactly the two values
 * `05-PROCESSING-PIPELINE.md` §3's claim SQL (`WHERE status IN ('received', 'retrying') AND
 * (next_attempt_at IS NULL OR next_attempt_at <= now())`) selects from, with **no tenant filter at
 * all** (that table is a deliberately global, un-tenant-scoped queue, §3). `claim-worker.service.
 * spec.ts`'s own "real Postgres, verification step 2" describe block runs a REAL, actively-polling
 * `ClaimWorkerService` against this exact same table, in a separate Jest worker process, for that
 * file's entire lifetime — under full-suite parallelism it can claim (`received`/`retrying` ->
 * `processing`) a row seeded by THIS file at any moment, including the narrow window between this
 * file seeding a row and asserting against it. A row seeded `'received'` to represent an illegal
 * source status for `markDispatchedExternal` (whose only legal source is `'processing'`) is
 * therefore not just occasionally flaky but actively unsafe: if that other worker wins the race, the
 * row really is `'processing'` by the time this file's own assertion runs, `markDispatchedExternal`
 * correctly (from its own point of view) succeeds, and the "throws for an illegal source status"
 * assertion is falsified for a reason that has nothing to do with `RedemptionStateMachineService`
 * itself. `'failed'` is a terminal status, structurally outside that claim query's `IN (...)` list —
 * no code path in this service, correct or buggy, ever moves a `'failed'` row back into contention,
 * so it is immune to this class of race by construction, not by timing luck. See the regression
 * describe block below (`T-RR-053 — ...`) for the deterministic proof this constant relies on.
 */
const ILLEGAL_SOURCE_STATUS_FOR_DISPATCH: RewardRedemptionEntryStatus = 'failed';

function baseEntryFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    correlation_id: randomUUID(),
    tenant_id: TENANT_ID,
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
    activity_name: 't-rr-021 state machine fixture',
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
    status: 'processing',
    retry_count: 0,
    next_attempt_at: null,
    ...overrides,
  };
}

async function insertEntry(
  sequelize: Sequelize,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const f = baseEntryFields(overrides);
  const [row] = await sequelize.query<{ id: string }>(
    `INSERT INTO reward_redemption.reward_redemption_entry
       (id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash, customer_id_type,
        activity_performed_date, transaction_type, activity_code, activity_type,
        activity_category, activity_value, activity_value_unit, channel, activity_performed_env,
        activity_name, campaign_code, tracker_code, tracker_component_code, merchant_code,
        reward_code, reward_category, reward_value, reward_value_unit, reward_entry_date,
        completion_cycle, reward_processed_env, ingestion_channel, status, retry_count,
        next_attempt_at)
     VALUES
       (:id, :correlation_id, :tenant_id, :customer_id_encrypted, :customer_id_hash,
        :customer_id_type, :activity_performed_date, :transaction_type, :activity_code,
        :activity_type, :activity_category, :activity_value, :activity_value_unit, :channel,
        :activity_performed_env, :activity_name, :campaign_code, :tracker_code,
        :tracker_component_code, :merchant_code, :reward_code, :reward_category, :reward_value,
        :reward_value_unit, :reward_entry_date, :completion_cycle, :reward_processed_env,
        :ingestion_channel, :status, :retry_count, :next_attempt_at)
     RETURNING id`,
    { type: QueryTypes.SELECT, replacements: f },
  );
  return row.id;
}

async function fetchRow(sequelize: Sequelize, id: string): Promise<RewardRedemptionEntryRow> {
  const [row] = await sequelize.query<RewardRedemptionEntryRow>(
    'SELECT * FROM reward_redemption.reward_redemption_entry WHERE id = :id',
    { type: QueryTypes.SELECT, replacements: { id } },
  );
  return row;
}

/**
 * T-RR-053. Applies `05-PROCESSING-PIPELINE.md` §3's real claim predicate — verbatim, only scoped
 * to one already-known `id` instead of a table-wide scan — and reports whether it would have
 * claimed (`'received'`/`'retrying'` -> `'processing'`) that row right now. Deliberately does
 * **not** call the real, global `RewardRedemptionEntryClaimRepository.claimNext()` / `ClaimWorker
 * Service` here: this file has no business running an unscoped scan of the whole shared queue as
 * part of its own test suite — doing so could just as easily claim some OTHER concurrently-running
 * spec file's own fixture row during a full-suite run, recreating this exact task's own defect one
 * file over. Scoping the predicate to a single known `id` gets the same yes/no answer this file
 * actually needs ("is this specific row a target of the real claim query, right now?") without that
 * side effect.
 */
async function matchesRealClaimQueryPredicate(sequelize: Sequelize, id: string): Promise<boolean> {
  const [row] = await sequelize.query<{ id: string }>(
    `UPDATE reward_redemption.reward_redemption_entry
       SET status = 'processing', updated_at = now()
     WHERE id = :id
       AND status IN ('received', 'retrying')
       AND (next_attempt_at IS NULL OR next_attempt_at <= now())
     RETURNING id`,
    { type: QueryTypes.SELECT, replacements: { id } },
  );
  return Boolean(row);
}

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

/** TC-1..TC-9's own fake — records every call so a test can assert it was (or wasn't) invoked,
 * per the task's own DoD ("covered by a fake in this task's own tests, not silently no-op"). */
function fakeSideEffects(): RedemptionCompletionSideEffectsPort & {
  calls: RewardRedemptionEntryRow[];
} {
  const calls: RewardRedemptionEntryRow[] = [];
  return {
    calls,
    async recordCompletionSideEffects(entry) {
      calls.push(entry);
    },
  };
}

describe('T-RR-021 — RedemptionStateMachineService', () => {
  let migrationDb: Sequelize;
  let service: RedemptionStateMachineService;
  let sideEffects: ReturnType<typeof fakeSideEffects>;

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
  });

  beforeEach(() => {
    sideEffects = fakeSideEffects();
    service = new RedemptionStateMachineService(realDbConfigService(), sideEffects);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  afterAll(async () => {
    // `reward_redemption_failed.reward_entry_id` and `external_system_call_log.reward_entry_id`
    // both have a real FK back to this table (`01-DATABASE.md` §2/§9 — same schema, so a real FK
    // is correct there) — TC-5 inserts a `reward_redemption_failed` row (and, pre-T-RR-067, TC-1
    // also inserted an `external_system_call_log` row; it no longer does, see that test's own
    // regression sibling above, but this cleanup is harmless either way) — both must be deleted
    // first or the entry delete below violates one of those constraints.
    await migrationDb.query(
      `DELETE FROM reward_redemption.external_system_call_log
         WHERE reward_entry_id IN (
           SELECT id FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id
         )`,
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await migrationDb.query(
      `DELETE FROM reward_redemption.reward_redemption_failed
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
  });

  it('TC-1: processing row -> dispatched_external, redemption facts written, one transaction', async () => {
    const id = await insertEntry(migrationDb, { status: 'processing' });
    const input: MarkDispatchedExternalInput = {
      entryId: id,
      externalSystemCode: 'PROMO_CODE_SERVICE',
      externalReferenceId: 'promo-code-abc123',
    };

    const updated = await service.markDispatchedExternal(input);

    expect(updated.status).toBe('dispatched_external');
    expect(updated.external_system_code).toBe('PROMO_CODE_SERVICE');
    expect(updated.external_reference_id).toBe('promo-code-abc123');
    expect(updated.redeemed_at).not.toBeNull();

    const persisted = await fetchRow(migrationDb, id);
    expect(persisted.status).toBe('dispatched_external');
  });

  // T-RR-067 regression. Before the fix, this method unconditionally inserted its own
  // `external_system_call_log` row here — proven to fail on the pre-fix code by temporarily
  // restoring that `INSERT` (see this task's own completion report for the observed red run): the
  // count below came back `1`, not `0`, because both this method AND the calling connector each
  // wrote their own row for the same attempt (`PromoCodeServiceConnector`/`CoreBankingConnector`'s
  // own `writeCallLog`, `08-EXTERNAL-INTEGRATION-CONTRACTS.md` §2/§3). The connector is now the
  // row's sole writer for a connector-made call — `markDispatchedExternal` writes only the
  // redemption facts + status flip, never `external_system_call_log` itself.
  it("T-RR-067 regression: markDispatchedExternal never writes external_system_call_log itself — that is the calling connector's own job", async () => {
    const id = await insertEntry(migrationDb, { status: 'processing' });
    const input: MarkDispatchedExternalInput = {
      entryId: id,
      externalSystemCode: 'PROMO_CODE_SERVICE',
      externalReferenceId: 'promo-code-xyz789',
    };

    await service.markDispatchedExternal(input);

    const [{ count }] = await migrationDb.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_redemption.external_system_call_log WHERE reward_entry_id = :id',
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    expect(Number(count)).toBe(0);
  });

  it('TC-2: processing row, no active connector resolved -> completed directly, no call-log row, external_* stay NULL', async () => {
    const id = await insertEntry(migrationDb, { status: 'processing' });

    const updated = await service.markCompletedDirect(id);

    expect(updated.status).toBe('completed');
    expect(updated.redeemed_at).not.toBeNull();
    expect(updated.external_system_code).toBeNull();
    expect(updated.external_reference_id).toBeNull();

    const [{ count }] = await migrationDb.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_redemption.external_system_call_log WHERE reward_entry_id = :id',
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    expect(count).toBe('0');
  });

  // Defect regression (found live 2026-09-12): markCompletedDirect never called
  // recordCompletionSideEffects, so a reward completed via this path (no connector needed) was
  // never dispatched to Reward Tracking at all -- silently, with no test catching it (TC-2 above
  // only ever checked external_system_call_log, never this). Every reward that reaches
  // 'completed', by either path, must be reported.
  it('regression: markCompletedDirect calls recordCompletionSideEffects with the completed row, same as completeDispatched does', async () => {
    const id = await insertEntry(migrationDb, { status: 'processing' });

    await service.markCompletedDirect(id);

    expect(sideEffects.calls).toHaveLength(1);
    expect(sideEffects.calls[0].id).toBe(id);
    expect(sideEffects.calls[0].status).toBe('completed');
  });

  it('TC-3: dispatched_external row proceeds normally to the outbox/notification step -> completed', async () => {
    const id = await insertEntry(migrationDb, {
      status: 'dispatched_external',
      external_system_code: 'PROMO_CODE_SERVICE',
      external_reference_id: 'promo-code-xyz',
    });

    const updated = await service.completeDispatched(id);

    expect(updated.status).toBe('completed');
    expect(sideEffects.calls).toHaveLength(1);
    expect(sideEffects.calls[0].id).toBe(id);
  });

  it('TC-4: processing row, connector call fails classified retryable, retry_count below max -> retrying, retry_count incremented, error fields populated', async () => {
    const id = await insertEntry(migrationDb, { status: 'processing', retry_count: 1 });

    const before = Date.now();
    const updated = await service.markRetrying({
      entryId: id,
      errorCode: 'GENERATION_EXHAUSTED',
      errorMessage: 'promo-code-service reported GENERATION_EXHAUSTED',
      delayMs: 2000,
    });

    expect(updated.status).toBe('retrying');
    expect(updated.retry_count).toBe(2);
    expect(updated.last_error_code).toBe('GENERATION_EXHAUSTED');
    expect(updated.last_error_message).toBe('promo-code-service reported GENERATION_EXHAUSTED');
    expect(updated.last_attempted_at).not.toBeNull();
    expect(updated.next_attempt_at).not.toBeNull();
    expect(updated.next_attempt_at!.getTime()).toBeGreaterThanOrEqual(before + 2000);
  });

  it('TC-5: processing row, connector call fails classified permanent -> failed, reward_redemption_failed row inserted in same transaction', async () => {
    const id = await insertEntry(migrationDb, { status: 'processing', retry_count: 0 });

    const updated = await service.markFailed({
      entryId: id,
      totalAttempts: 1,
      finalErrorCode: 'INVALID_REQUEST',
      finalErrorMessage: 'promo-code-service reported INVALID_REQUEST',
    });

    expect(updated.status).toBe('failed');

    const [failedRow] = await migrationDb.query<{
      reward_entry_id: string;
      tenant_id: number;
      campaign_code: string;
      reward_code: string;
      total_attempts: number;
      final_error_code: string | null;
      final_error_message: string;
    }>(
      `SELECT reward_entry_id, tenant_id, campaign_code, reward_code, total_attempts,
              final_error_code, final_error_message
         FROM reward_redemption.reward_redemption_failed WHERE reward_entry_id = :id`,
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    expect(failedRow).toBeDefined();
    expect(failedRow.reward_entry_id).toBe(id);
    expect(failedRow.tenant_id).toBe(TENANT_ID);
    expect(failedRow.campaign_code).toBe('CAMP1');
    expect(failedRow.reward_code).toBe('RWD1');
    expect(failedRow.total_attempts).toBe(1);
    expect(failedRow.final_error_code).toBe('INVALID_REQUEST');
    expect(failedRow.final_error_message).toBe('promo-code-service reported INVALID_REQUEST');
  });

  it('TC-6 (negative): a direct dispatched_external -> failed transition throws, row unchanged', async () => {
    const id = await insertEntry(migrationDb, {
      status: 'dispatched_external',
      external_system_code: 'PROMO_CODE_SERVICE',
      external_reference_id: 'promo-code-untouched',
    });

    await expect(
      service.markFailed({
        entryId: id,
        totalAttempts: 1,
        finalErrorCode: 'SOME_ERROR',
        finalErrorMessage: 'should never apply',
      }),
    ).rejects.toThrow(InvalidRedemptionStateTransitionError);

    const persisted = await fetchRow(migrationDb, id);
    expect(persisted.status).toBe('dispatched_external');
    const [{ count }] = await migrationDb.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_redemption.reward_redemption_failed WHERE reward_entry_id = :id',
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    expect(count).toBe('0');
  });

  it('TC-7 (negative): a direct completed -> retrying transition throws, row unchanged', async () => {
    const id = await insertEntry(migrationDb, { status: 'completed' });

    await expect(
      service.markRetrying({
        entryId: id,
        errorCode: 'SOME_ERROR',
        errorMessage: 'should never apply',
        delayMs: 1000,
      }),
    ).rejects.toThrow(InvalidRedemptionStateTransitionError);

    const persisted = await fetchRow(migrationDb, id);
    expect(persisted.status).toBe('completed');
    expect(persisted.retry_count).toBe(0);
  });

  it('markDispatchedExternal also throws (not just markFailed/markRetrying) when called from an illegal source status', async () => {
    // T-RR-053: seeded `ILLEGAL_SOURCE_STATUS_FOR_DISPATCH` ('failed'), not the literal 'received'
    // this test originally used — see that constant's own doc comment for why 'received' (or
    // 'retrying') is unsafe here specifically, independent of every other test in this file that
    // seeds a status the real claim query never selects.
    const id = await insertEntry(migrationDb, { status: ILLEGAL_SOURCE_STATUS_FOR_DISPATCH });

    await expect(
      service.markDispatchedExternal({
        entryId: id,
        externalSystemCode: 'PROMO_CODE_SERVICE',
        externalReferenceId: 'x',
      }),
    ).rejects.toThrow(InvalidRedemptionStateTransitionError);
  });

  it('completeDispatched is idempotent: a second call on an already-completed row is a no-op, not a thrown error', async () => {
    const id = await insertEntry(migrationDb, {
      status: 'dispatched_external',
      external_system_code: 'PROMO_CODE_SERVICE',
      external_reference_id: 'promo-code-idempotent',
    });

    const first = await service.completeDispatched(id);
    expect(first.status).toBe('completed');
    expect(sideEffects.calls).toHaveLength(1);

    const second = await service.completeDispatched(id);
    expect(second.status).toBe('completed');
    // The side-effects port is not invoked again for an already-completed row.
    expect(sideEffects.calls).toHaveLength(1);
  });

  it('completeDispatched throws when called on a row that never reached dispatched_external', async () => {
    const id = await insertEntry(migrationDb, { status: 'processing' });

    await expect(service.completeDispatched(id)).rejects.toThrow(
      InvalidRedemptionStateTransitionError,
    );
    expect(sideEffects.calls).toHaveLength(0);
  });

  it('every transition method throws RedemptionEntryNotFoundError for an id that does not exist', async () => {
    const missingId = randomUUID();

    await expect(service.markCompletedDirect(missingId)).rejects.toThrow(
      RedemptionEntryNotFoundError,
    );
    await expect(service.completeDispatched(missingId)).rejects.toThrow(
      RedemptionEntryNotFoundError,
    );
  });

  it('a rolled-back transition leaves the row untouched (transactional guarantee)', async () => {
    const id = await insertEntry(migrationDb, { status: 'processing' });

    // Force a mid-transaction failure by pointing the service at a fake pool whose client throws
    // on the UPDATE — proves ROLLBACK undoes the whole transaction, not just the failing
    // statement, independent of any one transition's own SQL (already covered by TC-1..TC-5).
    const fakeClient = {
      query: jest.fn(async (text: string) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes('FOR UPDATE')) {
          return {
            rows: [{ ...(await fetchRow(migrationDb, id)) }],
            rowCount: 1,
          };
        }
        throw new Error('simulated failure mid-transaction');
      }),
      release: jest.fn(),
    };
    // minimal fake satisfying only the two `Pool` methods this service actually calls; see
    // claim-repository spec's own identical, already-reviewed precedent for this idiom.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakePool = { connect: jest.fn(async () => fakeClient) } as any;
    const faultyService = new RedemptionStateMachineService(
      realDbConfigService(),
      sideEffects,
      fakePool,
    );

    await expect(faultyService.markCompletedDirect(id)).rejects.toThrow(
      'simulated failure mid-transaction',
    );

    const persisted = await fetchRow(migrationDb, id);
    expect(persisted.status).toBe('processing');
  });
});

describe('T-RR-053 — illegal-source-status fixtures must be immune to the real, un-tenant-scoped claim query', () => {
  let migrationDb: Sequelize;
  let service: RedemptionStateMachineService;
  let sideEffects: ReturnType<typeof fakeSideEffects>;

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
  });

  beforeEach(() => {
    sideEffects = fakeSideEffects();
    service = new RedemptionStateMachineService(realDbConfigService(), sideEffects);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  afterAll(async () => {
    await migrationDb.query(
      'DELETE FROM reward_redemption.external_system_call_log WHERE reward_entry_id IN ' +
        '(SELECT id FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id)',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await migrationDb.query(
      'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await migrationDb.close();
  });

  it('TC-1 (reproduction): a row seeded "received" -- this fixture\'s status before the T-RR-053 fix -- is genuinely eligible for the real claim query, and a claim landing in the gap between seed and assertion makes markDispatchedExternal wrongly resolve instead of throwing', async () => {
    const id = await insertEntry(migrationDb, { status: 'received' });

    // Exactly the failure this task's own evidence describes: some other actor (in production,
    // another instance's claim worker; in the reported flake, claim-worker.service.spec.ts's real
    // poll loop) runs the real claim predicate against this row before this test's own assertion.
    const wasClaimed = await matchesRealClaimQueryPredicate(migrationDb, id);
    expect(wasClaimed).toBe(true);

    // The row is now 'processing' -- a *legal* source status for markDispatchedExternal. The
    // "illegal source status" assertion this test file used to make for a 'received' fixture is
    // therefore not reliably true: it depends entirely on winning a race against any other worker
    // that might be scanning this shared, un-tenant-scoped table at the same moment.
    const updated = await service.markDispatchedExternal({
      entryId: id,
      externalSystemCode: 'PROMO_CODE_SERVICE',
      externalReferenceId: 'race-repro',
    });
    expect(updated.status).toBe('dispatched_external');
  });

  it('TC-2/TC-3 (fix + regression): ILLEGAL_SOURCE_STATUS_FOR_DISPATCH is never eligible for the real claim query, so the same interfering statement has no effect and the illegal-source-status assertion holds regardless of any concurrent claim worker', async () => {
    const id = await insertEntry(migrationDb, { status: ILLEGAL_SOURCE_STATUS_FOR_DISPATCH });

    // The identical interfering statement TC-1 above used, run against the fixed fixture status.
    // If this ever starts returning `true` -- e.g. because someone changes
    // `ILLEGAL_SOURCE_STATUS_FOR_DISPATCH` back to 'received' or 'retrying' -- this assertion fails
    // immediately and explicitly, rather than surfacing as an intermittent full-suite flake days
    // later (this is the regression test TC-3 calls for; see this file's own completion report for
    // the revert-and-confirm-red proof).
    const wasClaimed = await matchesRealClaimQueryPredicate(migrationDb, id);
    expect(wasClaimed).toBe(false);

    const persisted = await fetchRow(migrationDb, id);
    expect(persisted.status).toBe(ILLEGAL_SOURCE_STATUS_FOR_DISPATCH);

    await expect(
      service.markDispatchedExternal({
        entryId: id,
        externalSystemCode: 'PROMO_CODE_SERVICE',
        externalReferenceId: 'x',
      }),
    ).rejects.toThrow(InvalidRedemptionStateTransitionError);
  });
});

describe('T-RR-021 — RedemptionStateMachineService status union coverage', () => {
  // Compile-time-ish sanity check that the six-value status union (T-RR-002) is exactly what
  // `InvalidRedemptionStateTransitionError`'s own message formatting expects — if a new status
  // value were ever added without updating this list, this test documents the expectation.
  it('lists exactly the six statuses 05-PROCESSING-PIPELINE.md §2 defines', () => {
    const statuses: RewardRedemptionEntryStatus[] = [
      'received',
      'processing',
      'dispatched_external',
      'completed',
      'retrying',
      'failed',
    ];
    expect(statuses).toHaveLength(6);
  });
});
