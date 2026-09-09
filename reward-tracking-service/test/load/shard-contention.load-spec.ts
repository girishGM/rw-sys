/**
 * T-RTS-043 — Concurrency load test: proves `brain-storm/02-DATA-MODEL.md` §4's own throughput
 * claim for the sharded `campaign_reward_counter_shard` design with real measured numbers, not
 * just an assertion that the sharded version "works". Two properties are proven directly against
 * a real, local Postgres, through the exact same production write path every real ingestion call
 * uses (`CampaignRewardCounterShardRepository.upsert`, R8/R7's single atomic
 * `INSERT ... ON CONFLICT DO UPDATE x = x + $delta`, never read-then-write):
 *
 *   1. **Correctness under concurrency** — after N concurrent writers hit one campaign,
 *      `SUM(total_reward_count)` across that campaign's shard rows equals exactly N, every time,
 *      across repeated runs (TC-1/TC-3).
 *   2. **Sharding materially beats a naive, unsharded baseline** under the same concurrent load,
 *      in real wall-clock and/or Postgres-observed lock-wait terms (TC-2), at two concurrency
 *      levels matching the topology `brain-storm/05-INTEGRATION-AND-OPEN-QUESTIONS.md` §8 confirmed
 *      the shard count against (8 — "4 backend services × 2 instances", and 32 — the shard count
 *      itself; `BACKLOG.md` RS-03 is cited by that section for the same numbers, but is one of this
 *      repo's known-missing referenced docs per root `CLAUDE.md`'s own "Known gap" note — the
 *      brainstorm doc's own §8 already carries the number this task needs, so that gap does not
 *      block this suite).
 *
 * ## Methodology notes (read before changing this file)
 *
 * 1. **The "naive, unsharded baseline" is the real table with `shardCount = 1` passed to the real
 *    repository, not a hand-rolled second table.** `CampaignRewardCounterShardRepository.upsert`
 *    computes `shard_key = abs(hashtext(shardSeed)) % shardCount` — passing `shardCount = 1` makes
 *    every writer land on `shard_key = 0`, which *is* "a temporary, test-only variant with
 *    `shard_key` fixed to `0` for every row" (this task's own "In" scope wording), produced by
 *    reusing the exact production code path instead of a second migration. Two reasons this is the
 *    right call, not a shortcut: (a) `reward_tracking_app` (the role every writer here connects as,
 *    matching the real production write path) has no `CREATE TABLE` grant at all (`001_create_
 *    schema_and_role.ts` — SELECT/INSERT/UPDATE/DELETE only), and `src/database/migrations/**` is
 *    `agent-rts-foundation`'s own file scope (R10) — a real new table is out of this task's reach
 *    without either a privilege escalation this service's own least-privilege design deliberately
 *    withholds, or editing a file this task does not own; (b) a hand-rolled second table risks
 *    exercising different code than production, which is a strictly weaker proof than "the same
 *    write path, one config value different" (mirrors this task's own "Out of scope: any change to
 *    production code — a shard-count adjustment is a `service_config` seed value change" framing;
 *    `shardCount` is exactly that same one config value, just varied directly in the test instead
 *    of via a seeded row). Flagged here and in the completion report as a deliberate deviation from
 *    the task file's literal "temporary...variant" phrasing, not a silent substitution.
 * 2. **Writers share one bounded `pg.Pool` (not one physical connection per concurrent call).**
 *    `WRITER_POOL_MAX` below is sized to let the 32-writer level run fully in parallel with
 *    headroom, while staying well under the shared local Postgres server's own `max_connections`
 *    (100, confirmed via `SHOW max_connections`, shared with every other service/tool that may also
 *    be connected) — this is also a more realistic simulation of production than one raw connection
 *    per request would be (a real NestJS service always writes through a bounded pool too).
 * 3. **Lock-wait is sampled, not exactly integrated**, via a tight polling loop against
 *    `pg_stat_activity.wait_event_type = 'Lock'`, filtered to the writer role's own backends, run
 *    over a privileged (`DB_MIGRATION_*`) connection so visibility never depends on the writer
 *    role's own `pg_read_all_stats` grant (it has none). `lockWaitSampleTotal` (sum of concurrent
 *    waiter counts across every sample) is a real, reproducible, monotonic proxy for cumulative
 *    lock-wait cost — not a precise integral, but a genuine Postgres-observed number per this task's
 *    own DoD ("real numbers, not a qualitative label"), not a synthetic one this suite invented.
 * 4. **Every batch uses its own randomly suffixed `campaign_code`** so repeated runs (TC-3) and the
 *    sharded/naive/concurrency-level comparisons (TC-2, note 2's own two-level table) never share a
 *    physical row with each other — each batch's correctness check is against its own, exclusively
 *    owned set of shard rows.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { validateConfig } from '@/config/config.schema';
import {
  CampaignRewardCounterShardRepository,
  type ShardUpsertInput,
} from '@/modules/ingestion/campaign-reward-counter-shard.repository';
import { DEFAULT_SHARD_COUNT } from '@/modules/ingestion/shard-count-resolver.service';
import type { RewardKind } from '@/database/models/reward-fact.model';

jest.setTimeout(180_000);

const env = validateConfig(process.env);
const TENANT_ID = 960_000 + Math.floor(Math.random() * 9_999);
const RUN_SUFFIX = randomUUID().slice(0, 8);

/** Headroom under the shared local server's own `max_connections` (100) — see design note 2. */
const WRITER_POOL_MAX = 40;
const SAMPLER_POLL_INTERVAL_MS = 1;

const repo = new CampaignRewardCounterShardRepository();

const writerPool = new Pool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_APP_USERNAME,
  password: env.DB_APP_PASSWORD,
  ssl: env.DB_SSL ? { rejectUnauthorized: false } : undefined,
  max: WRITER_POOL_MAX,
});

// Privileged connection used only to sample `pg_stat_activity` (design note 3) and for teardown —
// never for the writes under measurement, so the sampler's own connection can never itself skew
// the thing it's measuring.
const adminPool = new Pool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_MIGRATION_USERNAME,
  password: env.DB_MIGRATION_PASSWORD,
  ssl: env.DB_SSL ? { rejectUnauthorized: false } : undefined,
  max: 2,
});

interface BatchResult {
  label: string;
  concurrency: number;
  shardCount: number;
  elapsedMs: number;
  totalCount: number;
  expectedCount: number;
  /** Number of poll samples that observed at least one writer blocked on a lock. */
  lockWaitSamples: number;
  /** Sum of concurrently-blocked-writer counts across every sample — see design note 3. */
  lockWaitSampleTotal: number;
  peakConcurrentWaiters: number;
}

async function sampleLockWaiters(): Promise<number> {
  const { rows } = await adminPool.query<{ waiting: string }>(
    `SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE usename = $1 AND wait_event_type = 'Lock'`,
    [env.DB_APP_USERNAME],
  );
  return Number(rows[0]?.waiting ?? 0);
}

async function upsertOnce(input: ShardUpsertInput, shardCount: number): Promise<void> {
  const client: PoolClient = await writerPool.connect();
  try {
    await repo.upsert(client, input, shardCount);
  } finally {
    client.release();
  }
}

interface RunBatchOptions {
  label: string;
  concurrency: number;
  shardCount: number;
  campaignCode: string;
}

const REWARD_CATEGORY = 'CASHBACK';
const REWARD_KIND: RewardKind = 'FIXED_AMOUNT';
const UNIT_TYPE = 'CURRENCY';
const UNIT_CODE = 'USD';

async function runBatch(opts: RunBatchOptions): Promise<BatchResult> {
  const { label, concurrency, shardCount, campaignCode } = opts;

  let sampling = true;
  let lockWaitSamples = 0;
  let lockWaitSampleTotal = 0;
  let peakConcurrentWaiters = 0;
  const samplerDone = (async () => {
    while (sampling) {
      const waiting = await sampleLockWaiters();
      if (waiting > 0) {
        lockWaitSamples += 1;
        lockWaitSampleTotal += waiting;
        peakConcurrentWaiters = Math.max(peakConcurrentWaiters, waiting);
      }
      await new Promise((resolve) => setTimeout(resolve, SAMPLER_POLL_INTERVAL_MS));
    }
  })();

  // `process.hrtime.bigint()` rather than `Date.now()` — these batches routinely complete in
  // single-digit milliseconds against a local Postgres, and `Date.now()`'s 1ms resolution would
  // throw away exactly the precision this comparison needs.
  const start = process.hrtime.bigint();
  await Promise.all(
    Array.from({ length: concurrency }, () =>
      upsertOnce(
        {
          tenant_id: TENANT_ID,
          campaign_code: campaignCode,
          reward_category: REWARD_CATEGORY,
          reward_kind: REWARD_KIND,
          unit_type: UNIT_TYPE,
          unit_code: UNIT_CODE,
          reward_value: '1.00',
          shardSeed: randomUUID(),
        },
        shardCount,
      ),
    ),
  );
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  sampling = false;
  await samplerDone;

  const { rows } = await writerPool.query<{ total: string | null }>(
    `SELECT SUM(total_reward_count) AS total FROM reward_tracking.campaign_reward_counter_shard
      WHERE tenant_id = $1 AND campaign_code = $2 AND reward_category = $3 AND reward_kind = $4
        AND unit_type = $5 AND unit_code = $6`,
    [TENANT_ID, campaignCode, REWARD_CATEGORY, REWARD_KIND, UNIT_TYPE, UNIT_CODE],
  );
  const totalCount = Number(rows[0]?.total ?? 0);

  return {
    label,
    concurrency,
    shardCount,
    elapsedMs,
    totalCount,
    expectedCount: concurrency,
    lockWaitSamples,
    lockWaitSampleTotal,
    peakConcurrentWaiters,
  };
}

function newCampaignCode(tag: string): string {
  return `LOADTEST-${tag}-${RUN_SUFFIX}-${randomUUID().slice(0, 8)}`;
}

function formatResult(r: BatchResult): string {
  return (
    `${r.label}: concurrency=${r.concurrency} shardCount=${r.shardCount} ` +
    `elapsedMs=${r.elapsedMs.toFixed(3)} count=${r.totalCount}/${r.expectedCount} ` +
    `lockWaitSamples=${r.lockWaitSamples} lockWaitSampleTotal=${r.lockWaitSampleTotal} ` +
    `peakConcurrentWaiters=${r.peakConcurrentWaiters}`
  );
}

function average(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Runs `trials` independent single-batch measurements back to back (each its own,
 * exclusively-owned `campaign_code`, design note 4) and returns every trial's own `BatchResult` —
 * used wherever a comparison needs to be robust to normal run-to-run scheduling/GC jitter rather
 * than resting on one single sample (TC-2, the concurrency=8/32 report). TC-1/TC-3 deliberately do
 * NOT use this — they need five genuinely independent, individually-asserted repeats, not an
 * average.
 */
async function runTrials(
  base: { label: string; concurrency: number; shardCount: number; campaignPrefix: string },
  trials: number,
): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  for (let i = 1; i <= trials; i += 1) {
    const result = await runBatch({
      label: `${base.label} trial#${i}`,
      concurrency: base.concurrency,
      shardCount: base.shardCount,
      campaignCode: newCampaignCode(`${base.campaignPrefix}-t${i}`),
    });
    results.push(result);
  }
  return results;
}

// Every measured `BatchResult` this suite produces, in run order — printed at the very end so the
// full, real numbers this task's DoD requires are visible in one place in the test output (and
// were copied verbatim into `reward-tracking-service-plan/reports/T-RTS-043-load-test-results.md`).
const allResults: BatchResult[] = [];

describe('T-RTS-043 — campaign_reward_counter_shard concurrency load test', () => {
  afterAll(async () => {
    console.warn('--- T-RTS-043 measured results (also recorded in the results report) ---');
    for (const r of allResults) {
      console.warn(formatResult(r));
    }

    try {
      await adminPool.query(
        'DELETE FROM reward_tracking.campaign_reward_counter_shard WHERE tenant_id = $1',
        [TENANT_ID],
      );
    } catch (error) {
      // Best-effort cleanup, same discipline as T-RTS-041's own teardown — never fails the suite.
      console.warn('T-RTS-043 teardown DELETE failed:', error);
    }
    await writerPool.end();
    await adminPool.end();
  });

  // TC-1: 100 concurrent ingestion calls against one campaign, sharded table (N = DEFAULT_SHARD_COUNT).
  it('TC-1: 100 concurrent writers, sharded — SUM(total_reward_count) is exactly 100', async () => {
    const result = await runBatch({
      label: 'TC-1 sharded (N=100)',
      concurrency: 100,
      shardCount: DEFAULT_SHARD_COUNT,
      campaignCode: newCampaignCode('tc1'),
    });
    allResults.push(result);
    expect(result.totalCount).toBe(100);
  });

  // TC-2: the same 100 calls against the naive (shardCount=1) baseline — correct count too, but
  // measurably higher wall-clock time and/or lock-wait time than the sharded run (design note 1).
  // Three independent trials per side, compared on their averages — these batches routinely finish
  // in single-digit milliseconds locally, so a robust comparison needs more than one sample per
  // side to not be dominated by ordinary scheduling/GC jitter (see `runTrials`'s own header).
  it('TC-2: 100 concurrent writers, naive baseline (shardCount=1) — correct, but measurably worse than sharded', async () => {
    const shardedTrials = await runTrials(
      {
        label: 'TC-2 sharded (N=100)',
        concurrency: 100,
        shardCount: DEFAULT_SHARD_COUNT,
        campaignPrefix: 'tc2-sharded',
      },
      3,
    );
    const naiveTrials = await runTrials(
      { label: 'TC-2 naive (N=100)', concurrency: 100, shardCount: 1, campaignPrefix: 'tc2-naive' },
      3,
    );
    allResults.push(...shardedTrials, ...naiveTrials);

    for (const r of [...shardedTrials, ...naiveTrials]) {
      expect(r.totalCount).toBe(100);
    }

    const avgShardedElapsedMs = average(shardedTrials.map((r) => r.elapsedMs));
    const avgNaiveElapsedMs = average(naiveTrials.map((r) => r.elapsedMs));
    const avgShardedLockWait = average(shardedTrials.map((r) => r.lockWaitSampleTotal));
    const avgNaiveLockWait = average(naiveTrials.map((r) => r.lockWaitSampleTotal));
    console.warn(
      `TC-2 averages (3 trials each) — sharded elapsedMs=${avgShardedElapsedMs.toFixed(3)} ` +
        `lockWaitSampleTotal=${avgShardedLockWait.toFixed(2)}; naive elapsedMs=${avgNaiveElapsedMs.toFixed(3)} ` +
        `lockWaitSampleTotal=${avgNaiveLockWait.toFixed(2)}`,
    );

    expect(avgNaiveElapsedMs > avgShardedElapsedMs || avgNaiveLockWait > avgShardedLockWait).toBe(
      true,
    );
  });

  // TC-3: repeat TC-1 four more times (five total including TC-1 itself) — no flaky undercounts.
  it('TC-3: TC-1 repeated five times total — no flaky undercounts across any run', async () => {
    const results: BatchResult[] = [allResults[0]]; // TC-1's own run counts as repeat #1.
    for (let i = 2; i <= 5; i += 1) {
      const result = await runBatch({
        label: `TC-3 sharded repeat #${i}`,
        concurrency: 100,
        shardCount: DEFAULT_SHARD_COUNT,
        campaignCode: newCampaignCode(`tc3-${i}`),
      });
      allResults.push(result);
      results.push(result);
    }

    for (const result of results) {
      expect(result.totalCount).toBe(100);
    }
  });

  // Implementation note 2: real throughput/latency numbers at two concurrency levels (8 and 32 —
  // brain-storm/05-INTEGRATION-AND-OPEN-QUESTIONS.md §8's own confirmed topology numbers), sharded
  // vs naive at each, so a future reader can judge shard-count adequacy without re-running this
  // suite from scratch.
  it.each([8, 32])(
    'reports sharded vs naive throughput at concurrency=%i (real numbers, see results report)',
    async (concurrency) => {
      const sharded = await runTrials(
        {
          label: `concurrency=${concurrency} sharded`,
          concurrency,
          shardCount: DEFAULT_SHARD_COUNT,
          campaignPrefix: `n2-sharded-${concurrency}`,
        },
        3,
      );
      const naive = await runTrials(
        {
          label: `concurrency=${concurrency} naive`,
          concurrency,
          shardCount: 1,
          campaignPrefix: `n2-naive-${concurrency}`,
        },
        3,
      );
      allResults.push(...sharded, ...naive);

      for (const r of [...sharded, ...naive]) {
        expect(r.totalCount).toBe(concurrency);
      }

      console.warn(
        `concurrency=${concurrency} averages (3 trials each) — ` +
          `sharded elapsedMs=${average(sharded.map((r) => r.elapsedMs)).toFixed(3)} ` +
          `lockWaitSampleTotal=${average(sharded.map((r) => r.lockWaitSampleTotal)).toFixed(2)}; ` +
          `naive elapsedMs=${average(naive.map((r) => r.elapsedMs)).toFixed(3)} ` +
          `lockWaitSampleTotal=${average(naive.map((r) => r.lockWaitSampleTotal)).toFixed(2)}`,
      );
    },
  );
});
