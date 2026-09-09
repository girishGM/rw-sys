/**
 * T-RR-020 — `RewardRedemptionEntryClaimRepository`, exercised against the real Postgres 16
 * server (root `CLAUDE.md`), never a mock/in-memory DB (this task's own verification step 3).
 *
 * A note on shared-table isolation: `reward_redemption_entry`'s claim query is deliberately
 * *not* scoped by tenant (`05-PROCESSING-PIPELINE.md` §3 — one global work queue, by design), so
 * a test here can, in principle, observe/claim a `received`/`retrying` row left behind by another
 * test file running concurrently in a different Jest worker against the same real database
 * (`test/database/reward-redemption-entry.migration.spec.ts` already accepts this same tradeoff
 * for its own TC-5 bulk fixture), or claimed by an entirely different, concurrently-running claim
 * worker (`claim-worker.service.spec.ts`'s own "real Postgres" test starts one against this exact
 * same table). Every test below is written to tolerate that: instead of asserting "the very first
 * `claimNext()` call, made by this specific repository instance, returns exactly my row", tests
 * either (a) assert a property that holds regardless of what else is in the table (TC-3, TC-7), or
 * (b) poll until *this test's own* seeded id reaches `processing` in the database, regardless of
 * which worker actually claimed it (`claimUntil`) — correct however many foreign rows or foreign
 * workers happen to interleave.
 *
 * T-RR-048 (defect fix): tolerating a foreign claim is not the same as *stranding* it. Every claim
 * loop below that has no ownership stake in what it just claimed (`claimUntil`'s own non-matching
 * branch, TC-3, TC-5's own non-seeded branch) now gives that row back immediately
 * (`giveBackForeignRow`) rather than leaving it stuck in `processing` forever — the actual root
 * cause diagnosed for T-RR-048 (a real, actively-polling `ClaimWorkerService` or a tight
 * `claimNext()` loop here permanently "eating" another concurrently-running spec file's own
 * fixture, e.g. `test/database/reward-redemption-entry.migration.spec.ts`'s single-row status
 * round-trip, or `test/modules/reward-ingestion/**`'s own real-DB inserts). TC-4 is the one
 * exception: its own exit condition depends on the *whole shared table* becoming momentarily
 * empty, so an unconditional give-back there really could livelock it against its own released
 * rows if it ever became the last active claimer — it instead spends a bounded give-back budget
 * and falls back to the pre-T-RR-048 behavior (leave it claimed) once that's exhausted, keeping
 * its own original termination guarantee intact; see TC-4's own comment for the rest.
 *
 * T-RR-052 (defect fix — this recurred under plain parallel `npm test` even with T-RR-048 done):
 * "give it back" is a *separate* statement issued after `RewardRedemptionEntryClaimRepository
 * .claimNext()`'s own transaction has already committed `status = 'processing'` — an unavoidable
 * (from a test file, without touching that production method) window during which a *different*,
 * concurrently-running real-Postgres file (specifically `claim-worker.service.spec.ts`, which polls
 * this exact same table) can observe one of its own fixture rows sitting in `processing` a moment
 * before this file's own reactive give-back flips it back to `received` — and, worse, reproduced
 * directly: TC-4's *own* bounded give-back budget (see its own comment) is sized for ordinary
 * contention, not for a sibling file's own concurrent fixture volume, and running out of budget at
 * the wrong moment permanently strands one of that sibling's rows in `processing` instead of
 * merely delaying it. Both are two different failure signatures of the same underlying cause
 * (T-RR-052's own evidence, reproduced twice: once each way). `npx jest --runInBand` never hits
 * either, because nothing else is ever running at the same moment as this file. Fixed two ways:
 * (1) `CROSS_FILE_CLAIM_TEST_MUTEX_KEY` below — a real session-level Postgres advisory lock, held
 * for this file's entire real-Postgres describe block, that fully serializes this file's own claim
 * activity against `claim-worker.service.spec.ts`'s own claim activity (same key, see that file's
 * own copy of this constant) rather than trying to make an inherently racy shared-queue observation
 * merely less likely to be caught mid-flight; and (2) TC-4's give-back budget is now tracked
 * *per row id* rather than as one shared counter across the whole loop, so a single sibling file's
 * fixture volume can no longer exhaust the *entire* budget before TC-4 ever gets back around to
 * that specific row a second time — see TC-4's own comment for why a per-row bound still preserves
 * its termination guarantee.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { createMigrationConnection } from '@/database/migration-connection';
import { RewardRedemptionEntryClaimRepository } from '@/modules/processing/reward-redemption-entry-claim.repository';
import type { Config } from '@/config/config.schema';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';

const TENANT_ID = 920_000 + Math.floor(Math.random() * 79_999);

/**
 * T-RR-052. The Postgres session-level advisory lock key shared with `claim-worker.service.spec.ts`
 * (see that file's own copy of this exact constant — the two must match, or this stops serializing
 * anything). Held for this file's entire real-Postgres describe block; see this file's own header
 * comment for why. `pg_advisory_lock`/`pg_advisory_unlock` take a single `bigint` — this fits
 * comfortably in a plain JS number (well under `Number.MAX_SAFE_INTEGER`), so no `bigint` literal
 * is needed here.
 */
const CROSS_FILE_CLAIM_TEST_MUTEX_KEY = 52_020_021;

// The claim query's own scan order is `ORDER BY created_at` (05-PROCESSING-PIPELINE.md §3) across
// the *entire* shared, un-tenant-scoped table (file header) — every other concurrently-running
// test file's own fixtures use the column's real `now()` default. Deliberately backdating this
// file's own single-row fixtures into the year 2000 (a monotonically increasing counter, so this
// file's own relative insert order is still preserved) means they always sort ahead of *any*
// `now()`-dated foreign row, so a claim call resolves this file's own target immediately rather
// than having to drain however many foreign rows another test happens to have queued up at that
// moment. This is what actually fixes the contention (previously "worked around" with
// progressively longer wall-clock timeouts, up to 60s, which does not scale as more sibling tasks
// add their own concurrent fixtures) rather than merely tolerating more of it.
const OLD_TIMESTAMP_BASE_MS = Date.parse('2000-01-01T00:00:00.000Z');
let oldTimestampSeq = 0;
function nextOldTimestamp(): Date {
  oldTimestampSeq += 1;
  return new Date(OLD_TIMESTAMP_BASE_MS + oldTimestampSeq);
}

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
    activity_name: 't-rr-020 claim repository fixture',
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
    created_at: nextOldTimestamp(),
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
        completion_cycle, reward_processed_env, ingestion_channel, status, next_attempt_at,
        created_at)
     VALUES
       (:id, :correlation_id, :tenant_id, :customer_id_encrypted, :customer_id_hash,
        :customer_id_type, :activity_performed_date, :transaction_type, :activity_code,
        :activity_type, :activity_category, :activity_value, :activity_value_unit, :channel,
        :activity_performed_env, :activity_name, :campaign_code, :tracker_code,
        :tracker_component_code, :merchant_code, :reward_code, :reward_category, :reward_value,
        :reward_value_unit, :reward_entry_date, :completion_cycle, :reward_processed_env,
        :ingestion_channel, :status, :next_attempt_at, :created_at)
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

/** A `ConfigService` stand-in reading the real `.env.development` values already loaded by
 * `test/database/env.setup.ts` — same substitution idiom as `test/health/health.e2e-spec.ts`'s
 * own `fakeConfig`, just pointed at the real values instead of a deliberately-broken port. */
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

/**
 * T-RR-048. Gives back a claimed row this test doesn't recognize as its own — leaving it stuck in
 * `processing` forever (the old behavior) is exactly the defect T-RR-048 diagnosed: a
 * concurrently-running sibling spec file (or another agent's own real-DB spec, e.g. `test/modules/
 * reward-ingestion/**`) that owns that row would then see its own `received`/`retrying` fixture
 * silently vanish underneath its own assertion, or its own claim-based test starve waiting for a
 * row that will never come back. Bumping `created_at` (not just `status`) moves the released row
 * to the back of the claim query's own `ORDER BY created_at` — without this, a released row that's
 * still the table's global minimum gets reclaimed-and-released by this exact loop over and over
 * (a livelock, the identical class of bug `realtime-activity-processing-service`'s own T-RAP-047
 * already found and fixed for its own analogous test helper) instead of ever making progress.
 */
async function giveBackForeignRow(migrationDb: Sequelize, id: string): Promise<void> {
  await migrationDb.query(
    `UPDATE reward_redemption.reward_redemption_entry
       SET status = 'received', updated_at = now(), created_at = now()
     WHERE id = :id`,
    { type: QueryTypes.RAW, replacements: { id } },
  );
}

/** Drives `claimNext()` (contributing to draining whatever else is in the shared queue) until
 * this test's own `targetId` reaches `processing`, tolerating any number of foreign rows claimed
 * along the way (see file header) — including by an entirely different, concurrently-running
 * claim worker. T-RR-048: every non-matching claim is given back immediately
 * (`giveBackForeignRow`) rather than left stuck in `processing` — this loop's own exit condition
 * depends only on `targetId` reaching `processing`, never on the shared table becoming globally
 * empty, so giving back cannot livelock this function itself.
 *
 * Deliberately checks the row's own *persisted* status (`fetchRow`) rather than requiring this
 * specific `repository.claimNext()` call to be the one that returns `targetId`: `claim-worker.
 * service.spec.ts`'s own "real Postgres" test starts a genuine, actively-polling `ClaimWorkerService`
 * against this exact same shared, un-tenant-scoped table (`05-PROCESSING-PIPELINE.md` §3 — one
 * global work queue, by design), and Jest runs both spec files as separate, concurrently-scheduled
 * processes. If that worker's own poll loop wins the race for `targetId` before this function's own
 * next `claimNext()` call does, that is a *correct* outcome of the exact `SKIP LOCKED` design this
 * whole module exists to prove (any worker may claim any eligible row) — asserting "specifically
 * *my* call must be the one" was asserting an implementation detail the architecture explicitly
 * does not guarantee, not a real requirement.
 *
 * Bounded by a wall-clock deadline rather than a fixed attempt count: another test file's own
 * bulk-fixture insert (e.g. TC-7 below, or `test/database/reward-redemption-entry.migration.spec.ts`'s
 * own 15,000-row TC-5, neither of which deletes its rows until its own `afterAll`) can leave many
 * thousands of foreign eligible rows in the table at once — a low fixed attempt count (this used to
 * be a flat `200`) fails on that interleaving alone, not on any real defect. In the common case this
 * resolves in a single iteration regardless: every fixture in this file is deliberately backdated to
 * the year 2000 (see `nextOldTimestamp`), so it always sorts ahead of any `now()`-dated foreign row
 * in the claim query's own `ORDER BY created_at`. */
async function claimUntil(
  migrationDb: Sequelize,
  repository: RewardRedemptionEntryClaimRepository,
  targetId: string,
  timeoutMs = 60_000,
): Promise<RewardRedemptionEntryRow> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const claimed = await repository.claimNext();
    if (claimed && claimed.id !== targetId) {
      await giveBackForeignRow(migrationDb, claimed.id);
    }
    const row = await fetchRow(migrationDb, targetId);
    if (row?.status === 'processing') {
      return row;
    }
  }
  throw new Error(`claimUntil: ${targetId} did not reach 'processing' within ${timeoutMs}ms`);
}

describe('T-RR-020 — RewardRedemptionEntryClaimRepository', () => {
  let migrationDb: Sequelize;
  let repository: RewardRedemptionEntryClaimRepository;
  // T-RR-052: a dedicated, single connection holding the cross-file mutex for this describe
  // block's entire lifetime — a session-level advisory lock is tied to the specific connection
  // that acquired it, so this must be one `Client`, never a pooled `Sequelize` instance that could
  // route the lock/unlock calls to two different underlying connections.
  let mutexClient: Client;

  beforeAll(async () => {
    // T-RR-052: acquire the cross-file mutex FIRST, before any fixture or claim activity in this
    // file starts — see `CROSS_FILE_CLAIM_TEST_MUTEX_KEY`'s own comment. This blocks here until
    // `claim-worker.service.spec.ts` (if it got there first) releases its own copy of the same
    // lock in its own `afterAll`.
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
    // T-RR-052: `beforeAll` needs its OWN generous timeout here — reproduced directly, this hook
    // can legitimately block on `pg_advisory_lock` above for far longer than Jest's own 5000ms
    // default hook timeout while `claim-worker.service.spec.ts`'s own real-Postgres describe block
    // (several tests, each with its own up-to-90s bound) still holds the lock, especially under
    // heavy real-world contention (this project's own concurrently running orchestrator can
    // dispatch another `npm test` at the same time). Without this, Jest throws "Exceeded timeout
    // of 5000 ms for a hook" on the mutex wait itself, which looks like (but is not) a deadlock.
  }, 300_000);

  afterAll(async () => {
    await migrationDb.query(
      'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await migrationDb.close();
    // `onModuleDestroy()` is the repository's own public lifecycle hook (Nest calls it
    // automatically in a real app on shutdown) — using it here instead of reaching into the
    // private `pool` field closes the same connection without an unchecked cast (R2).
    await repository.onModuleDestroy();
    // T-RR-052: release the mutex only after every other real-DB cleanup step above has finished,
    // so the sibling file can't start its own claim activity while this file's own teardown is
    // still touching the shared table.
    await mutexClient.query('SELECT pg_advisory_unlock($1::bigint)', [
      CROSS_FILE_CLAIM_TEST_MUTEX_KEY,
    ]);
    await mutexClient.end();
    // T-RR-052: same reasoning as `beforeAll`'s own extended timeout — this file's own
    // real-Postgres tests can each run up to 90s (TC-7 alone seeds/deletes 15,000 rows) and this
    // hook runs right after the last of them under whatever real-world load was already in play,
    // so it should not be left to inherit Jest's 5000ms default either.
  }, 60_000);

  // Each `claimUntil`-using test below gets a Jest timeout comfortably longer than
  // `claimUntil`'s own 60s internal deadline (rather than Jest's 5s default) — see `claimUntil`'s
  // own header for why that deadline can legitimately take a while under concurrent load.
  it('TC-1: seeds a `received` row and claims it — status flips to `processing`', async () => {
    const id = await insertEntry(migrationDb, { status: 'received' });

    const claimed = await claimUntil(migrationDb, repository, id);

    expect(claimed.status).toBe('processing');
    const persisted = await fetchRow(migrationDb, id);
    expect(persisted.status).toBe('processing');
  }, 90_000);

  it('TC-2: seeds a `retrying` row (past due) and claims it — both statuses are eligible', async () => {
    const id = await insertEntry(migrationDb, {
      status: 'retrying',
      next_attempt_at: new Date(Date.now() - 1000),
    });

    const claimed = await claimUntil(migrationDb, repository, id);

    expect(claimed.status).toBe('processing');
  }, 90_000);

  it('a `retrying` row whose `next_attempt_at` is still in the future is never claimed', async () => {
    const futureId = await insertEntry(migrationDb, {
      status: 'retrying',
      next_attempt_at: new Date(Date.now() + 60_000),
    });
    // A control row that WILL be claimed, so we have a definite stopping point.
    const controlId = await insertEntry(migrationDb, { status: 'received' });

    await claimUntil(migrationDb, repository, controlId);

    const persisted = await fetchRow(migrationDb, futureId);
    expect(persisted.status).toBe('retrying');
  }, 90_000);

  it('TC-3: `dispatched_external` and `completed` rows are never claimed', async () => {
    const dispatchedId = await insertEntry(migrationDb, {
      status: 'dispatched_external',
      external_system_code: 'PROMO_CODE_SERVICE',
      external_reference_id: 'ext-ref-1',
      redeemed_at: new Date(),
    });
    const completedId = await insertEntry(migrationDb, {
      status: 'completed',
      redeemed_at: new Date(),
    });
    const seenIds = new Set<string>();

    // Drain whatever is currently eligible (mine + any concurrent foreign rows) until two
    // consecutive empty polls — a bounded, deterministic stopping condition. This test seeds no
    // `received`/`retrying` row of its own, so every successful claim here is necessarily a
    // foreign row (T-RR-048) — given back immediately (`giveBackForeignRow`) so it isn't
    // permanently stranded in `processing` for whichever sibling spec file actually owns it. The
    // `i < 500` bound (not "until globally empty") is what keeps this safe from a give-back
    // livelock: unlike `claimUntil`'s own analysis, this loop's own count/limit exits
    // unconditionally regardless of how the shared table's own contents evolve.
    let consecutiveEmpty = 0;
    for (let i = 0; i < 500 && consecutiveEmpty < 2; i += 1) {
      const claimed = await repository.claimNext();
      if (claimed) {
        seenIds.add(claimed.id);
        consecutiveEmpty = 0;
        await giveBackForeignRow(migrationDb, claimed.id);
      } else {
        consecutiveEmpty += 1;
      }
    }

    expect(seenIds.has(dispatchedId)).toBe(false);
    expect(seenIds.has(completedId)).toBe(false);
    // T-RR-052: this test had no explicit Jest timeout at all before this fix, silently inheriting
    // the 5000ms default — up to 500 real round-trip DB calls (claim + give-back) under real
    // contention from a concurrently-running sibling file can easily exceed that, which is a timing
    // artifact of shared-table contention, not a defect in this repository's own claim behavior
    // (same reasoning every other `claimUntil`-based test in this file already applies).
  }, 90_000);

  it('TC-4: an empty queue returns `null`, never throws', async () => {
    // Not "drain, then assert the one following call is null": on this shared, un-tenant-scoped
    // table (file header), a concurrent test file can insert a fresh eligible row in the gap
    // between "looks drained" and that one following call, which would make that specific
    // assertion flaky for a reason that has nothing to do with this repository's own
    // correctness. The actual property TC-4 needs — an empty/momentarily-empty poll resolves
    // `null` rather than throwing — only requires observing `null` at least once within a
    // bounded window, which holds regardless of how other tests interleave. A wall-clock
    // deadline (not a fixed attempt count) for the same reason `claimUntil` uses one: a
    // concurrently-running sibling agent's own bulk fixtures can mean many thousands of real,
    // non-`null` claims happen before the queue is ever momentarily empty.
    //
    // T-RR-048: gives back what it claims too (like `claimUntil`/TC-3/TC-5 above), but through a
    // *bounded give-back budget* rather than unconditionally — unlike those three, this loop's own
    // exit condition depends on the *entire* shared table becoming momentarily empty, so an
    // unconditional give-back really could livelock it: if this test ever became the last active
    // claimer against a single remaining foreign row, claim-and-release would repeat forever and
    // this loop would never see `null` within the deadline (the exact opposite of what T-RR-048
    // fixes elsewhere). Spending a generous but finite budget on giving rows back — helping
    // whichever sibling file actually owns them in the common case — and then falling back to the
    // pre-T-RR-048 behavior (leave it claimed) once that budget is exhausted keeps the original
    // termination guarantee intact: after the budget runs out, this loop's own eligible pool can
    // only ever shrink from here, exactly as before this fix, so it is still guaranteed to reach
    // empty within the deadline.
    //
    // T-RR-052 (defect fix): that budget used to be a single counter shared across *every distinct
    // row* this loop ever claimed — reproduced directly stranding a sibling file's own fixture row
    // in `processing` forever, because a sibling file's own fixture volume (e.g. a bulk seed
    // running at the same moment in a different Jest worker against this exact table) can hand this
    // loop 50 different *one-off* foreign rows before it ever gets back around to any single row a
    // second time, exhausting the whole budget on rows that were never actually livelock risks.
    // Tracking the budget *per row id* instead fixes that: the only row that can ever exhaust its
    // own budget is one this exact loop keeps re-claiming-and-releasing itself (the genuine
    // livelock candidate the comment above is actually guarding against), which still terminates
    // exactly the same way once its own bound is hit — every other, merely-passing-through foreign
    // row keeps being given back regardless of how many *other* distinct rows this loop has already
    // seen.
    let sawNullWithoutThrowing = false;
    const giveBackAttemptsById = new Map<string, number>();
    const MAX_GIVE_BACKS_PER_ROW = 20;
    const deadline = Date.now() + 60_000;
    while (!sawNullWithoutThrowing && Date.now() < deadline) {
      const claimed = await repository.claimNext();
      if (claimed === null) {
        sawNullWithoutThrowing = true;
        continue;
      }
      const attempts = giveBackAttemptsById.get(claimed.id) ?? 0;
      if (attempts < MAX_GIVE_BACKS_PER_ROW) {
        giveBackAttemptsById.set(claimed.id, attempts + 1);
        await giveBackForeignRow(migrationDb, claimed.id);
      }
    }

    expect(sawNullWithoutThrowing).toBe(true);
  }, 90_000);

  it('TC-5 (concurrency): 20 seeded rows, 10 concurrent claimers — every row claimed exactly once, never twice', async () => {
    const seededIds = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      seededIds.add(await insertEntry(migrationDb, { status: 'received' }));
    }

    const allClaimedIds: string[] = [];
    const remaining = new Set(seededIds);
    // A wall-clock deadline, not a fixed round count (this used to be a flat `rounds < 50`):
    // under heavy concurrent load from sibling agents' own test runs hammering this same shared
    // table (see `claimUntil`'s own header), most of a fixed, small number of rounds can be
    // consumed claiming *foreign* rows ahead of this test's own 20 in `created_at` order, well
    // before this test's own rows are ever reached — a real starvation risk for a small fixed
    // round budget, not a correctness defect in the claim SQL itself (proven separately by
    // TC-1/TC-2/TC-6).
    const deadline = Date.now() + 60_000;
    while (remaining.size > 0 && Date.now() < deadline) {
      const results = await Promise.all(Array.from({ length: 10 }, () => repository.claimNext()));
      for (const claimed of results) {
        if (!claimed) {
          continue;
        }
        if (remaining.has(claimed.id)) {
          allClaimedIds.push(claimed.id);
          remaining.delete(claimed.id);
        } else {
          // T-RR-048: a foreign row that happened to interleave — given back immediately
          // (`giveBackForeignRow`) rather than left stuck in `processing`, so it isn't
          // permanently stranded away from whichever sibling spec file actually owns it. Not
          // recorded in `allClaimedIds`: giving it back makes it legitimately re-claimable by a
          // *later* round of this same loop, which would otherwise trip the duplicate check below
          // for a row that was never actually double-claimed at the same moment, only claimed,
          // released, and claimed again — the exclusivity guarantee that check exists to prove
          // only concerns claims that could plausibly race each other, and once released a row is
          // no different from a brand new one for that purpose. This loop's own exit condition
          // (`remaining.size === 0`, or the deadline) is unaffected by foreign give-backs either
          // way, so this cannot livelock the way an unconditional "drain until globally empty"
          // loop could.
          await giveBackForeignRow(migrationDb, claimed.id);
        }
      }
    }

    expect(remaining.size).toBe(0);
    // The real exclusivity guarantee, scoped to this test's own 20 seeded rows (never given
    // back, so each can only legitimately appear once): no id is ever returned by two different
    // `claimNext()` calls at once.
    const duplicates = allClaimedIds.filter((id, index) => allClaimedIds.indexOf(id) !== index);
    expect(duplicates).toEqual([]);

    // Scoped to this test's own seeded ids, not the whole shared `TENANT_ID` — the describe
    // block's other tests (TC-3, the future-`next_attempt_at` case) share the same `TENANT_ID`
    // and deliberately leave rows behind in `dispatched_external`/`completed`/`retrying`, which
    // would make a tenant-wide status assertion here fail on unrelated fixtures rather than on
    // this test's own claim behavior.
    const persistedRows = await migrationDb.query<RewardRedemptionEntryRow>(
      'SELECT id, status FROM reward_redemption.reward_redemption_entry WHERE id IN (:ids)',
      { type: QueryTypes.SELECT, replacements: { ids: Array.from(seededIds) } },
    );
    expect(persistedRows).toHaveLength(seededIds.size);
    expect(persistedRows.every((row) => row.status === 'processing')).toBe(true);
  }, 90_000);

  it('TC-6 (negative): a rolled-back claim transaction leaves the row untouched and re-claimable', async () => {
    // This test needs *exclusive* first access to its own fixture row — unlike every other test
    // in this file, it isn't enough for *some* worker to eventually claim it (`claimUntil`'s own
    // tolerant design); it specifically needs to be the manual transaction below, so it can force
    // a ROLLBACK instead of a COMMIT. That is fundamentally in tension with backdating fixtures to
    // the year 2000 (this file's own contention fix, see `nextOldTimestamp`): a backdated row is
    // the *most* attractive target for any other actively-polling claim worker (in particular
    // `claim-worker.service.spec.ts`'s own "real Postgres" test, running concurrently in a
    // separate Jest process against this exact same table), so it can legitimately lose the race
    // for its own row before the manual `UPDATE` below even runs — a real, correct outcome of the
    // shared-queue design, not a bug. A bounded retry with a fresh row on that specific,
    // detectable outcome (`result.rowCount === 0`) is the honest fix: it does not weaken what
    // TC-6 actually verifies (the ROLLBACK guarantee), it just tolerates losing the initial race
    // for exclusive access and tries again with a new fixture.
    const rawConfig = realDbConfigService();
    let id = '';
    let claimResult: { rowCount: number | null } = { rowCount: 0 };
    for (let attempt = 0; attempt < 10 && claimResult.rowCount !== 1; attempt += 1) {
      id = await insertEntry(migrationDb, { status: 'received' });

      // Same shape as the repository's own transaction, run manually so it can be forced to
      // ROLLBACK instead of COMMIT — proving the transactional guarantee TC-6 requires,
      // independent of the repository's own row-selection logic (already covered by TC-1/TC-5).
      const client = new Client({
        host: rawConfig.get('DB_HOST', { infer: true }),
        port: rawConfig.get('DB_PORT', { infer: true }),
        database: rawConfig.get('DB_NAME', { infer: true }),
        user: rawConfig.get('DB_APP_USERNAME', { infer: true }),
        password: rawConfig.get('DB_APP_PASSWORD', { infer: true }),
      });
      await client.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<RewardRedemptionEntryRow>(
          `UPDATE reward_redemption.reward_redemption_entry
             SET status = 'processing', updated_at = now()
             WHERE id = $1 AND status IN ('received', 'retrying')
             RETURNING *`,
          [id],
        );
        claimResult = result;
        if (result.rowCount === 1) {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [id]);
          // Simulate a crash/failure between acquiring the lock and committing.
        }
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
    }
    expect(claimResult.rowCount).toBe(1);

    const afterRollback = await fetchRow(migrationDb, id);
    expect(afterRollback.status).toBe('received');

    const claimed = await claimUntil(migrationDb, repository, id);
    expect(claimed.status).toBe('processing');
  }, 90_000);

  it('TC-6b: the repository itself rolls back when the transaction errors mid-flight', async () => {
    const queryCalls: string[] = [];
    const fakeClient = {
      query: jest.fn(async (text: string) => {
        queryCalls.push(text);
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
          return { rows: [], rowCount: 0 };
        }
        throw new Error('simulated failure mid-transaction');
      }),
      release: jest.fn(),
    };
    // T-RR-020: minimal fake satisfying only the two `Pool` methods this repository actually
    // calls; typing it as a real `Pool` would require implementing the entire `pg` surface for no
    // additional safety.
    const fakePool = {
      connect: jest.fn(async () => fakeClient),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
    } as any;

    const repo = new RewardRedemptionEntryClaimRepository(realDbConfigService(), fakePool);

    await expect(repo.claimNext()).rejects.toThrow('simulated failure mid-transaction');
    expect(queryCalls).toEqual(['BEGIN', expect.stringContaining('UPDATE'), 'ROLLBACK']);
  });

  // A realistic ~10%-eligible status mix (2 of 20 rows `received`/`retrying`, the rest terminal),
  // not an even 1-in-5 split across all five statuses — this was proven by hand, directly via
  // `psql`, against this exact shared table while building this test. An even split (~40%
  // eligible, what `test/database/reward-redemption-entry.migration.spec.ts`'s own sibling TC-5
  // uses) is *not* reliably index-favoring: at 40% selectivity Postgres's own cost-based planner
  // chose `Seq Scan + Sort` over the partial index at 12,000/15,000/30,000/50,000/80,000 rows
  // alike whenever the table had just been `VACUUM FULL`-ed (i.e. no physical bloat) — it only
  // "passed" at 40% selectivity when the shared table already carried bloat from other tests'
  // own inserts/deletes earlier in the same run, which is exactly the kind of environment-order
  // dependent flakiness a real test must not rely on. A ~10%-eligible mix, by contrast, is both
  // *more representative of production* (at any snapshot, the overwhelming majority of rows have
  // already reached a terminal status; only a small trickle sits in `received`/`retrying`) and
  // reliably chooses the index at 5,000+ rows even immediately after a fresh `VACUUM FULL` (the
  // worst case for the index, confirmed by hand) — so this test's outcome depends on the
  // selectivity this query's own `WHERE` clause actually has in the real world, not on incidental
  // physical bloat left behind by whichever other test files happened to run first.
  it('TC-7: EXPLAIN on the real claim query uses ix_rre_status_next_attempt, not a sequential scan, at 15,000+ rows with a realistic (~10%-eligible) status mix', async () => {
    await migrationDb.query(
      `INSERT INTO reward_redemption.reward_redemption_entry
         (id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash,
          customer_id_type, activity_performed_date, activity_type, activity_category,
          activity_value, activity_value_unit, channel, activity_performed_env, activity_name,
          campaign_code, tracker_code, tracker_component_code, reward_code, reward_category,
          reward_value, reward_value_unit, reward_entry_date, reward_processed_env,
          ingestion_channel, status, next_attempt_at)
       SELECT gen_random_uuid(), gen_random_uuid(), :tenant_id, 'ciphertext-placeholder',
              'hash-' || g, 'EMAIL', now(), 'PURCHASE', 'SPEND', 10, 'USD', 'WEB', 'PROD',
              't-rr-020 TC-7 bulk seed', 'CAMP1', 'TRK1', 'COMP1', 'RWD1', 'CASHBACK', 5, 'USD',
              now(), 'development', 'REST',
              CASE
                WHEN g % 20 = 0 THEN 'received'
                WHEN g % 20 = 1 THEN 'retrying'
                ELSE (ARRAY['completed','failed','processing','dispatched_external'])[(g % 4) + 1]
              END,
              CASE WHEN g % 3 = 0 THEN now() + interval '60 seconds' ELSE NULL END
       FROM generate_series(1, 15000) g`,
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await migrationDb.query('ANALYZE reward_redemption.reward_redemption_entry;', {
      type: QueryTypes.RAW,
    });

    interface PlanNode {
      'Node Type': string;
      'Index Name'?: string;
      Plans?: PlanNode[];
    }
    function planUsesIndex(node: PlanNode, indexName: string): boolean {
      if (node['Index Name'] === indexName) {
        return true;
      }
      return (node.Plans ?? []).some((child) => planUsesIndex(child, indexName));
    }
    function planHasSeqScan(node: PlanNode): boolean {
      if (node['Node Type'] === 'Seq Scan') {
        return true;
      }
      return (node.Plans ?? []).some((child) => planHasSeqScan(child));
    }

    const [explainRow] = await migrationDb.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
      `EXPLAIN (FORMAT JSON)
       SELECT id FROM reward_redemption.reward_redemption_entry
       WHERE status IN ('received','retrying')
         AND (next_attempt_at IS NULL OR next_attempt_at <= now())
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      { type: QueryTypes.SELECT },
    );
    const plan = explainRow['QUERY PLAN'][0].Plan;

    expect(planUsesIndex(plan, 'ix_rre_status_next_attempt')).toBe(true);
    expect(planHasSeqScan(plan)).toBe(false);

    // Delete this test's own 15,000-row bulk fixture immediately rather than waiting for the
    // describe block's `afterAll` — this table is a shared, un-tenant-scoped global queue
    // (`claimUntil`'s own header), so every extra second these ~1,500 eligible rows sit around is
    // extra contention for any *other* test file's own claim-based test running concurrently in a
    // different Jest worker against the same real Postgres instance.
    await migrationDb.query(
      'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    // T-RR-052: this test had no explicit Jest timeout at all before this fix, silently inheriting
    // the 5000ms default — a real 15,000-row bulk insert + `ANALYZE` + `EXPLAIN` + delete against a
    // real Postgres instance under real contention from a concurrently-running sibling file can
    // exceed that comfortably without indicating any defect in this repository's own claim query.
  }, 90_000);
});
