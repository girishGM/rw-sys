/**
 * T-RAP-021. Integration tests against the real local Postgres 16 server (root `CLAUDE.md`),
 * connected as the real least-privilege `rap_app` role — same real-DB convention
 * `campaign-config-snapshot.repository.spec.ts` (T-RAP-010) already established for this project.
 * A large, randomly-offset `tenant_id` per run is safe and never collides with real data (same
 * reasoning that file's own header gives).
 *
 * This is where `uc_activity_logs_fanout`'s `ON CONFLICT DO NOTHING` behaviour is actually proven
 * under real Postgres semantics — TC-6 (redelivery of the exact same dedupKey is a no-op) and TC-7
 * (concurrent redelivery never surfaces a unique-constraint crash to either caller) both need a
 * real unique index and real transactional concurrency, not a mock. Verification step 2 (row
 * shapes match `01-DATABASE.md` §3 exactly) is proven here too, against the real table.
 */
import 'reflect-metadata';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes, type Transaction } from 'sequelize';
import {
  ActivityLogsRepository,
  type FanOutRowInput,
} from '@/modules/activity-mapping/activity-logs.repository';
import type { ActivityLogRow } from '@/database/models/activity-log.model';

const TENANT_ID = 920_000 + Math.floor(Math.random() * 79_999);

function row(overrides: Partial<FanOutRowInput> = {}): FanOutRowInput {
  return {
    correlationId: '11111111-1111-4111-8111-111111111111',
    dedupKey: 'dedup-default',
    tenantId: TENANT_ID,
    customerIdEncrypted: 'ciphertext-base64==',
    customerIdHash: 'a'.repeat(64),
    customerIdType: 'INTERNAL_ID',
    activityPerformedDate: new Date('2026-09-01T10:15:30.000Z'),
    transactionType: null,
    activityCode: 'PURCHASE',
    activityType: 'TRANSACTION',
    activityCategory: 'RETAIL',
    activityValue: '100.0000',
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

describe('ActivityLogsRepository (real Postgres, rap_app role)', () => {
  let sequelize: Sequelize;
  let repository: ActivityLogsRepository;

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
    repository = new ActivityLogsRepository(sequelize);
  });

  afterAll(async () => {
    await sequelize.query(
      'DELETE FROM realtime_activity_processing.activity_logs WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await sequelize.close();
  });

  it('is a no-op ([] in, [] out) for an empty row list, without querying the DB', async () => {
    const result = await sequelize.transaction((t) => repository.insertFanOutRows([], t));
    expect(result).toEqual([]);
  });

  // TC-1/verification step 2: single matched component -> one pending row, exact column shapes.
  //
  // T-RAP-053: the readback SELECT below runs inside the *same*, still-open transaction as the
  // insert itself, not as a separate statement issued after commit (the pattern that flagged this
  // defect for the multi-row test further down). `claimNextPendingRow()` is genuinely global
  // (`05-PROCESSING-PIPELINE.md` §4, never scoped to this test's own rows), so once this insert's
  // transaction commits, any concurrently-running claim-worker/rule-evaluation/tracker-completion/
  // cap-enforcement suite's own real claim loop can legitimately claim this freshly-`'pending'` row
  // before a later, separate `SELECT` gets a chance to read it, flipping `status` out from under
  // this test. Postgres MVCC makes an uncommitted insert invisible to every other session's query
  // — including that global claim query — until this transaction actually commits; reading the row
  // back from inside the same transaction, before that happens, removes the race entirely rather
  // than merely narrowing its odds (see the regression test at the bottom of this file, which
  // proves both halves of that claim against a real concurrent claimant).
  it('inserts one row per matched component and every column matches 01-DATABASE.md §3', async () => {
    const input = row({
      dedupKey: 'dedup-tc1',
      correlationId: '22222222-2222-4222-8222-222222222222',
    });

    const { inserted, dbRow } = await sequelize.transaction(async (t) => {
      const insertedRows = await repository.insertFanOutRows([input], t);
      const [readBack] = await sequelize.query<ActivityLogRow>(
        'SELECT * FROM realtime_activity_processing.activity_logs WHERE id = :id',
        { type: QueryTypes.SELECT, replacements: { id: insertedRows[0].id }, transaction: t },
      );
      return { inserted: insertedRows, dbRow: readBack };
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toEqual({
      id: expect.any(String),
      dedupKey: 'dedup-tc1',
      campaignCode: 'CAMP1',
      trackerCode: 'TRK1',
      trackerComponentCode: 'COMP1',
    });

    expect(dbRow.correlation_id).toBe('22222222-2222-4222-8222-222222222222');
    expect(dbRow.dedup_key).toBe('dedup-tc1');
    expect(dbRow.tenant_id).toBe(TENANT_ID);
    expect(dbRow.customer_id_encrypted).toBe('ciphertext-base64==');
    expect(dbRow.customer_id_hash).toBe('a'.repeat(64));
    expect(dbRow.customer_id_type).toBe('INTERNAL_ID');
    expect(new Date(dbRow.activity_performed_date).toISOString()).toBe('2026-09-01T10:15:30.000Z');
    expect(dbRow.transaction_type).toBeNull();
    expect(dbRow.activity_code).toBe('PURCHASE');
    expect(dbRow.activity_type).toBe('TRANSACTION');
    expect(dbRow.activity_category).toBe('RETAIL');
    expect(Number(dbRow.activity_value)).toBe(100);
    expect(dbRow.activity_value_unit).toBe('USD');
    expect(dbRow.channel).toBe('WEB');
    expect(dbRow.activity_performed_env).toBe('PROD');
    expect(dbRow.activity_name).toBe('Online purchase');
    expect(dbRow.campaign_code).toBe('CAMP1');
    expect(dbRow.tracker_code).toBe('TRK1');
    expect(dbRow.tracker_component_code).toBe('COMP1');
    expect(dbRow.merchant_code).toBeNull();
    expect(dbRow.source_transport).toBe('GRPC');
    expect(dbRow.status).toBe('pending');
    expect(dbRow.error_code).toBeNull();
    expect(dbRow.comment).toBeNull();
    expect(dbRow.activity_reached_date).toBeInstanceOf(Date);
    expect(dbRow.activity_processed_date).toBeNull();
  });

  // TC-2/TC-3: several matched components (same or different campaigns) in one call -> one row
  // per component, same correlation_id/dedup_key, all pending.
  //
  // T-RAP-053: this is the test the defect was originally reported against — see the header
  // comment on the single-row test above for the full root cause. The readback SELECT here now
  // runs inside the same still-open transaction as the insert, for the identical reason.
  it('inserts one row per matched component across several campaigns, all sharing correlation_id/dedup_key', async () => {
    const correlationId = '33333333-3333-4333-8333-333333333333';
    const dedupKey = 'dedup-tc3';
    const rows = [
      row({
        correlationId,
        dedupKey,
        campaignCode: 'CAMP1',
        trackerCode: 'TRK1',
        trackerComponentCode: 'COMP1',
      }),
      row({
        correlationId,
        dedupKey,
        campaignCode: 'CAMP2',
        trackerCode: 'TRK2',
        trackerComponentCode: 'COMP2',
      }),
    ];

    const { inserted, dbRows } = await sequelize.transaction(async (t) => {
      const insertedRows = await repository.insertFanOutRows(rows, t);
      const readBack = await sequelize.query<ActivityLogRow>(
        'SELECT * FROM realtime_activity_processing.activity_logs WHERE dedup_key = :dedupKey ORDER BY campaign_code',
        { type: QueryTypes.SELECT, replacements: { dedupKey }, transaction: t },
      );
      return { inserted: insertedRows, dbRows: readBack };
    });

    expect(inserted).toHaveLength(2);
    expect(new Set(inserted.map((r) => r.campaignCode))).toEqual(new Set(['CAMP1', 'CAMP2']));
    for (const r of inserted) {
      expect(r.dedupKey).toBe(dedupKey);
    }

    expect(dbRows).toHaveLength(2);
    expect(dbRows.every((r) => r.correlation_id === correlationId)).toBe(true);
    expect(dbRows.every((r) => r.status === 'pending')).toBe(true);
  });

  // TC-6: redelivery of the exact same (dedupKey, campaignCode, trackerCode, componentCode)
  // tuple(s) is a no-op — nothing new inserted, no error.
  it('a second call with the exact same tuples inserts nothing (ON CONFLICT DO NOTHING)', async () => {
    const dedupKey = 'dedup-tc6';
    const input = row({ dedupKey });

    const first = await sequelize.transaction((t) => repository.insertFanOutRows([input], t));
    expect(first).toHaveLength(1);

    const second = await sequelize.transaction((t) => repository.insertFanOutRows([input], t));
    expect(second).toEqual([]);

    const dbRows = await sequelize.query(
      'SELECT id FROM realtime_activity_processing.activity_logs WHERE dedup_key = :dedupKey',
      { type: QueryTypes.SELECT, replacements: { dedupKey } },
    );
    expect(dbRows).toHaveLength(1);
  });

  // Task implementation note 4: partial duplicate — a later call for the same dedupKey with an
  // additional, previously-unmatched component inserts only the genuinely new row.
  it('a partial-duplicate call (same dedupKey, one new component) inserts only the new row', async () => {
    const dedupKey = 'dedup-partial';
    const first = row({ dedupKey, trackerComponentCode: 'COMP1' });
    const firstResult = await sequelize.transaction((t) => repository.insertFanOutRows([first], t));
    expect(firstResult).toHaveLength(1);

    const second = [
      row({ dedupKey, trackerComponentCode: 'COMP1' }), // already exists -> skipped
      row({ dedupKey, trackerComponentCode: 'COMP2' }), // genuinely new -> inserted
    ];
    const secondResult = await sequelize.transaction((t) => repository.insertFanOutRows(second, t));

    expect(secondResult).toHaveLength(1);
    expect(secondResult[0].trackerComponentCode).toBe('COMP2');
  });

  // TC-7: two concurrent redeliveries of the exact same dedupKey/tuple set never crash on the
  // unique-constraint violation — exactly one wins, the other gets [].
  it('two concurrent inserts of the identical tuple set never crash; exactly one wins', async () => {
    const dedupKey = 'dedup-tc7';
    const rows = [
      row({ dedupKey, trackerComponentCode: 'COMP1' }),
      row({ dedupKey, trackerComponentCode: 'COMP2' }),
    ];

    const [resultA, resultB] = await Promise.all([
      sequelize.transaction((t) => repository.insertFanOutRows(rows, t)),
      sequelize.transaction((t) => repository.insertFanOutRows(rows, t)),
    ]);

    const lengths = [resultA.length, resultB.length].sort();
    expect(lengths).toEqual([0, 2]);

    const dbRows = await sequelize.query(
      'SELECT id FROM realtime_activity_processing.activity_logs WHERE dedup_key = :dedupKey',
      { type: QueryTypes.SELECT, replacements: { dedupKey } },
    );
    expect(dbRows).toHaveLength(2);
  });

  // T-RAP-053 regression: proves the property the two fixes above rely on, against a real
  // concurrent claimant — deterministically, not by racing a background poller against an
  // artificial `setTimeout` window.
  //
  // An earlier version of this regression test drove the "concurrent claimant" as a busy-loop
  // polling on a timer, hoping to win a race against a 10ms delay inserted between commit and a
  // separate post-commit `SELECT`. That is exactly the class of flake this task exists to remove
  // (`AGENT-PROTOCOL.md` §3: "assert the observable property, not... " — a test whose own result
  // depends on which of two concurrent operations happens to finish first is not a reliable
  // assertion of anything) — under real machine/scheduler variance the poller sometimes did not
  // get scheduled inside the 10ms window at all, so `postCommitObservedNonPending` could
  // legitimately come back `0` even though the vulnerability is real, failing this test for an
  // unrelated reason. This version instead runs each side of the race to completion in a fixed,
  // known order — no sleep, no polling loop, nothing timing-dependent — using the exact query
  // shape `claimNextPendingRow()` itself runs (`activity-log-claim.repository.ts`,
  // `05-PROCESSING-PIPELINE.md` §4: `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)
  // RETURNING *`), scoped to this test's own row id so it can never claim anyone else's row:
  //
  //  - Post-commit (the bug this task fixes): insert+commit via the repository, exactly as
  //    production code does. *Then*, deterministically (no race — this statement is simply run
  //    and awaited to completion before anything else happens), a second, independent connection
  //    runs the real claim-query shape against that exact row id and — because the row is now
  //    committed and externally visible — genuinely claims it. Only *after* that has fully
  //    completed does this test perform the plain post-commit `SELECT` a naive caller would run.
  //    It deterministically observes `'processing'`, not `'pending'` — proving the row really was
  //    claimable in that window, not merely asserting the fixed code "looks right".
  //  - In-transaction (the fix, TC-1/TC-3 above): insert *and* read the row back inside the same
  //    still-open transaction, before commit. While that transaction is open, the identical
  //    claim-query shape is run from a second, independent connection against the same row id —
  //    genuinely concurrently, not simulated — and it claims *nothing* (`0` rows), because
  //    Postgres MVCC makes an uncommitted insert invisible to every other session's query,
  //    including a `SELECT ... FOR UPDATE SKIP LOCKED`, until this transaction actually commits.
  //    The in-transaction readback therefore always sees `'pending'`.
  //
  // Both halves are asserted every run, with no dependency on scheduling luck.
  async function claimRowById(id: string, transaction?: Transaction): Promise<string[]> {
    const claimed = await sequelize.query<{ id: string }>(
      `UPDATE realtime_activity_processing.activity_logs
          SET status = 'processing'
        WHERE id = (
          SELECT id FROM realtime_activity_processing.activity_logs
           WHERE id = :id AND status = 'pending'
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id`,
      { type: QueryTypes.SELECT, replacements: { id }, transaction },
    );
    return claimed.map((r) => r.id);
  }

  it('T-RAP-053 regression: a post-commit readback can observe a row a concurrent claimant already took; an in-transaction readback never can', async () => {
    const dedupKey = `dedup-t-rap-053-regression-${Math.random().toString(36).slice(2)}`;

    try {
      // --- Post-commit (the bug): insert commits, a real concurrent claimant takes the row,
      // *then* the plain post-commit SELECT a naive caller would run observes the aftermath.
      const postCommitInput = row({ dedupKey, trackerComponentCode: 'COMP-REG-POST' });
      const [postCommitInserted] = await sequelize.transaction((t) =>
        repository.insertFanOutRows([postCommitInput], t),
      );
      const postCommitClaimedIds = await claimRowById(postCommitInserted.id);
      expect(postCommitClaimedIds).toEqual([postCommitInserted.id]); // the claim genuinely won
      const [postCommitRow] = await sequelize.query<{ status: string }>(
        'SELECT status FROM realtime_activity_processing.activity_logs WHERE id = :id',
        { type: QueryTypes.SELECT, replacements: { id: postCommitInserted.id } },
      );
      expect(postCommitRow.status).toBe('processing'); // not 'pending' — the vulnerability, proven

      // --- In-transaction (the fix): the same concurrent claim query, run against the same shape
      // of row, while the insert's own transaction is still open — genuinely finds nothing.
      const inTxnInput = row({ dedupKey, trackerComponentCode: 'COMP-REG-INTXN' });
      const { inTxnStatus, concurrentClaimedIds } = await sequelize.transaction(async (t) => {
        const [inserted] = await repository.insertFanOutRows([inTxnInput], t);
        // Deliberately omits `transaction: t` — a second, independent connection/session, exactly
        // as any other concurrently-running suite's real claim-worker would be.
        const claimedIds = await claimRowById(inserted.id);
        const [dbRow] = await sequelize.query<{ status: string }>(
          'SELECT status FROM realtime_activity_processing.activity_logs WHERE id = :id',
          { type: QueryTypes.SELECT, replacements: { id: inserted.id }, transaction: t },
        );
        return { inTxnStatus: dbRow.status, concurrentClaimedIds: claimedIds };
      });
      expect(concurrentClaimedIds).toEqual([]); // MVCC: the uncommitted row was invisible to it
      expect(inTxnStatus).toBe('pending'); // the fix holds
    } finally {
      await sequelize.query(
        'DELETE FROM realtime_activity_processing.activity_logs WHERE dedup_key = :dedupKey',
        { type: QueryTypes.RAW, replacements: { dedupKey } },
      );
    }
  });
});
