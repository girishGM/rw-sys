/**
 * T-RAP-056 / T-RAP-041 (retry 1). Deterministic, real-process regression coverage for
 * `kafka-shared-consumer-group-lock.ts` — a single, reentrant, cross-process exclusive lock shared by
 * two differently-named entry points (`acquireIngestConsumerGroupWriterLock` for
 * `activity-ingest.consumer.e2e-spec.ts`'s own role, `acquireIngestConsumerGroupReaderLease` for
 * `full-pipeline-test-helpers.ts`'s own role). Same precedent
 * `activity-ingest.consumer.e2e-spec.ts`'s own T-RAP-055 regression `describe` block already set for
 * this project: prove the *mechanism* fast and deterministically here, rather than relying solely on
 * a slow, real-Kafka, real-multi-file reproduction for every future change.
 *
 * No Kafka/Postgres involved — this suite only ever exercises the lock module's own filesystem-based
 * mutual exclusion, using a real second OS process (`support/consumer-group-lock-child.ts`) for the
 * cross-process assertions, never a second in-process call standing in for one.
 *
 * **Why "writer" and "reader" share one mutex, not a real reader/writer lock.** An earlier rewrite of
 * this module (during T-RAP-041's own retry 1) let any number of `acquireIngestConsumerGroupReader-
 * Lease()` holders coexist, only ever waiting on a writer. Independent re-verification (running the
 * exact scoped `npm test -- full-pipeline` command 3 times) found that traded the review's ORIGINAL
 * reported timeout symptom for a worse, real correctness bug: `full-pipeline.e2e-spec.ts` and
 * `full-pipeline-multi-instance.e2e-spec.ts`'s own worker bundles could then run truly concurrently,
 * and their independently-instantiated `ActivityLogClaimWorker`s are each globally scoped (claim ANY
 * row from the whole `activity_logs` table) — a cross-file claim computes that row's reward/hash data
 * using the WRONG file's own `FIELD_ENCRYPTION_*` keys. See `kafka-shared-consumer-group-lock.ts`'s
 * own header for the full diagnosis. TC-R (below) is this suite's own proof that reader-vs-reader is
 * ONCE AGAIN exclusive across processes (the regression test for THAT specific defect returning).
 *
 * TC-3/TC-R3 are each their own "fails without the fix" proof required by T-RAP-056's own Definition
 * of Done: every `it()` in this file directly exercises code that did not exist before that task (the
 * whole module) — reverting `kafka-shared-consumer-group-lock.ts` to not exist (or reverting
 * `startInstance()`/`activity-ingest.consumer.e2e-spec.ts`'s own two integration points back to not
 * calling it) makes this file fail to even compile/run, which is exactly "fails when reverted".
 *
 * **TC-Fair (T-RAP-056 retry 1's own regression case).** Unlike TC-3/TC-R3 above, this one proves a
 * BEHAVIOURAL regression, not just "the module doesn't exist" — the exact defect the independent
 * reviewer's re-run disqualified the first submission for: a bare "whoever calls `mkdirSync` first"
 * race lets a repeat re-acquirer (this suite's own `hammer` mode, standing in for
 * `full-pipeline-multi-instance.e2e-spec.ts`'s own several sequential per-TC `startInstance()`/
 * `close()` cycles) starve out a stranger waiter that arrived first but only polls on
 * `POLL_INTERVAL_MS`. Confirmed by hand to fail on the pre-fix `acquire()` (a plain
 * `while (!tryAcquireMarker())` loop with no ticket queue) — see this task's own completion report
 * for the exact revert-and-rerun evidence — and to pass on the fixed, ticket-ordered `acquire()`.
 */
import 'reflect-metadata';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// T-RAP-056 (this retry). Root-caused during this retry's own full, unfiltered `npm test` gate run:
// this suite's own `beforeEach`/`afterEach` below unconditionally `rmSync`s the lock/queue
// directories to reset state between its OWN tests, and its own child processes acquire/release the
// SAME real mutex real `activity-ingest.consumer.e2e-spec.ts`/`full-pipeline(-multi-instance)
// .e2e-spec.ts` runs depend on for real cross-file correctness. Whenever Jest schedules this file in
// a separate worker process CONCURRENTLY with one of those real files (exactly what an unfiltered,
// default-parallelism `npm test` does), sharing that literal, hardcoded `/tmp` path meant this
// suite's own fast, deterministic tests could either (a) time out waiting behind a real writer now
// legitimately holding the lock for up to `MAX_REALISTIC_LOCK_HOLD_MS` (a real, reproduced failure:
// `acquireIngestConsumerGroupReaderLease: timed out after 90000ms ... queue position 1 of 2 (0 still
// ahead)` — not a fairness bug, the "current holder is real and legitimately busy" case this file's
// own small per-test budgets were never sized for), or worse, (b) actually delete the real lock out
// from under a real, currently-holding process via this file's own cleanup hooks — reopening the
// exact cross-file `ActivityLogClaimWorker` correctness hazard the whole module exists to prevent.
//
// Fix: this suite points the lock module at its own fresh, isolated root directory
// (`RAP_E2E_LOCK_ROOT_DIR`, read once at module-load time — see that constant's own doc comment in
// `kafka-shared-consumer-group-lock.ts`) instead of the real shared default, for both its own
// in-process calls AND its own spawned child processes (which inherit `process.env` — including this
// override — by default, since neither `spawnChild` nor `spawnHammer` below overrides `env`). This
// must be set BEFORE the module below is first imported (this project's own `commonjs` module target
// means plain statements execute in the exact order written, unlike ES module import hoisting — see
// this task's own completion report for the deliberate empirical check that confirmed this).
const LOCK_ROOT_DIR = mkdtempSync(join(tmpdir(), 'rap-e2e-lock-regression-'));
process.env.RAP_E2E_LOCK_ROOT_DIR = LOCK_ROOT_DIR;

import {
  acquireIngestConsumerGroupReaderLease,
  acquireIngestConsumerGroupWriterLock,
  releaseIngestConsumerGroupWriterLock,
  resetIngestConsumerGroupLockForTests,
  __testing,
} from './kafka-shared-consumer-group-lock';

// T-RAP-056. Generous relative to this suite's own real work (spawning a real, separate OS process
// per cross-process test, `HOLD_MS` values of a few seconds) specifically so a full, unfiltered
// `npm test` run's own legitimate CPU contention (dozens of other real Postgres/Kafka e2e suites'
// worker processes competing for the same cores) can't turn "the real child process took a bit
// longer to spawn/report" into a false failure here — same "don't let contention slack widen the
// *guarantee*, only the *budget*" discipline `activity-ingest.consumer.e2e-spec.ts`'s own
// T-RAP-052/T-RAP-055 headers already established for this project.
jest.setTimeout(120_000);
const CROSS_PROCESS_TEST_TIMEOUT_MS = 90_000;

const CHILD_SCRIPT = join(__dirname, 'support', 'consumer-group-lock-child.ts');
const TS_NODE_TRANSPILE_ONLY = join(
  __dirname,
  '..',
  '..',
  'node_modules',
  '.bin',
  'ts-node-transpile-only',
);

interface ChildOutcome {
  ok: boolean;
  requestedAt: number;
  acquiredAt?: number;
  error?: string;
}

type ChildMode = 'writer' | 'reader';

/** Spawns the real child process and resolves with its first stdout JSON line — the moment it
 * either acquires the lock/lease or gives up, not when it exits (it may still be holding it,
 * sleeping `holdMs`, for tests that need that). The returned `child` handle lets the caller await
 * full exit (and therefore the child's own release) separately. */
function spawnChild(
  mode: ChildMode,
  holdMs: number,
  acquireTimeoutMs?: number,
): {
  outcome: Promise<ChildOutcome>;
  exited: Promise<number | null>;
  child: ReturnType<typeof spawn>;
} {
  const args = [CHILD_SCRIPT, mode, String(holdMs)];
  if (acquireTimeoutMs !== undefined) {
    args.push(String(acquireTimeoutMs));
  }
  // T-RAP-056 (this retry). `env` is passed explicitly (not left to `spawn()`'s own "defaults to
  // `process.env`" behaviour) — Jest's own per-test-file sandboxing of the `process` global means a
  // mutation this file makes to `process.env` (setting `RAP_E2E_LOCK_ROOT_DIR` above, before this
  // module's own imports) is visible to code running inside THIS test file, but is NOT automatically
  // inherited by a child process spawned with no explicit `env` — confirmed empirically while
  // diagnosing this exact defect (see this task's own completion report). Reading `process.env`
  // directly at the point of each `spawn()` call, as its own object literal, sidesteps whatever this
  // project's Jest environment does to the ambient default.
  const child = spawn(TS_NODE_TRANSPILE_ONLY, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
  });

  const outcome = new Promise<ChildOutcome>((resolve, reject) => {
    const rl = createInterface({ input: child.stdout! });
    rl.once('line', (line) => {
      rl.close();
      try {
        resolve(JSON.parse(line) as ChildOutcome);
      } catch (error) {
        reject(error as Error);
      }
    });
    child.once('error', reject);
  });

  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });

  return { outcome, exited, child };
}

interface HammerIterationOutcome {
  ok: boolean;
  iteration: number;
  requestedAt: number;
  acquiredAt?: number;
  error?: string;
}

/** Spawns the real child process in `hammer` mode (see `consumer-group-lock-child.ts`'s own header)
 * — `iterations` back-to-back writer acquire/hold/release cycles with essentially zero delay between
 * one release and the next re-acquire attempt. `iterationsSeen` resolves with every iteration's own
 * outcome, in order, once the child has fully exited; `firstIterationAcquired` resolves as soon as
 * iteration 0 is confirmed acquired, without waiting for the rest, so a caller can spawn a stranger
 * competitor while the first hold is still in progress. */
function spawnHammer(
  iterations: number,
  holdMs: number,
): {
  iterationsSeen: Promise<HammerIterationOutcome[]>;
  firstIterationAcquired: Promise<HammerIterationOutcome>;
  exited: Promise<number | null>;
} {
  const args = [CHILD_SCRIPT, 'hammer', String(iterations), String(holdMs)];
  // See `spawnChild`'s own comment above for why `env` is passed explicitly here too.
  const child = spawn(TS_NODE_TRANSPILE_ONLY, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
  });

  const results: HammerIterationOutcome[] = [];
  let resolveFirst!: (outcome: HammerIterationOutcome) => void;
  const firstIterationAcquired = new Promise<HammerIterationOutcome>((resolve) => {
    resolveFirst = resolve;
  });

  const rl = createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    try {
      const parsed = JSON.parse(line) as HammerIterationOutcome;
      results.push(parsed);
      if (parsed.iteration === 0) {
        resolveFirst(parsed);
      }
    } catch {
      // Malformed line — ignore; the assertions below on `results.length`/`ok` will catch a child
      // that never reported cleanly.
    }
  });

  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      rl.close();
      resolve(code);
    });
  });

  const iterationsSeen = exited.then(() => results);

  return { iterationsSeen, firstIterationAcquired, exited };
}

describe('T-RAP-056 / T-RAP-041 (retry 1) regression: kafka-shared-consumer-group-lock', () => {
  beforeEach(() => {
    resetIngestConsumerGroupLockForTests();
  });

  afterEach(() => {
    resetIngestConsumerGroupLockForTests();
  });

  // T-RAP-056 (this retry). This suite's own isolated lock root (see `LOCK_ROOT_DIR`'s own doc
  // comment above) is a real temp directory this suite created — clean it up once, after every test
  // in this file has finished, rather than leaving it behind on disk.
  afterAll(() => {
    rmSync(LOCK_ROOT_DIR, { recursive: true, force: true });
  });

  it('TC-1 (reentrant, in-process): a second acquire from the SAME process never blocks on its own already-held lock', async () => {
    const start = Date.now();
    await acquireIngestConsumerGroupWriterLock();
    await acquireIngestConsumerGroupWriterLock();
    const elapsed = Date.now() - start;
    // Real proof, not a change-detector: an un-fixed non-reentrant lock would hang here until this
    // file's own `jest.setTimeout` killed the test — a few hundred ms is "returned immediately",
    // anything near a polling interval would mean it actually contended with itself.
    expect(elapsed).toBeLessThan(1_000);

    // Only fully released after BOTH matching release() calls.
    releaseIngestConsumerGroupWriterLock();
    expect(existsSync(__testing.lockDir)).toBe(true);
    releaseIngestConsumerGroupWriterLock();
    expect(existsSync(__testing.lockDir)).toBe(false);
  });

  it('TC-1R (reentrant, in-process, reader side): a second reader lease from the SAME process never blocks — this is what full-pipeline-multi-instance.e2e-spec.ts own two, sequential startInstance() calls rely on', async () => {
    const start = Date.now();
    const leaseA = await acquireIngestConsumerGroupReaderLease();
    const leaseB = await acquireIngestConsumerGroupReaderLease();
    expect(Date.now() - start).toBeLessThan(1_000);

    leaseA.release();
    expect(existsSync(__testing.lockDir)).toBe(true);
    leaseB.release();
    expect(existsSync(__testing.lockDir)).toBe(false);
  });

  it('TC-2 (safe no-op): releasing when nothing is held never throws', () => {
    expect(() => releaseIngestConsumerGroupWriterLock()).not.toThrow();
  });

  it(
    'TC-3 (cross-process mutual exclusion — the T-RAP-056 regression case): a second, real OS process cannot acquire the lock until the first, real holder actually releases it',
    async () => {
      const HOLD_MS = 1_500;
      const { outcome: childOutcome, exited: childExited } = spawnChild('writer', HOLD_MS);
      const child = await childOutcome;
      expect(child.ok).toBe(true);

      // The real proof this task exists to establish: this (parent) process's own acquire — a
      // completely independent OS process from the child above — must not resolve until the
      // child's own `holdMs` sleep has elapsed and it has actually called release().
      const beforeParentAcquire = Date.now();
      await acquireIngestConsumerGroupWriterLock(CROSS_PROCESS_TEST_TIMEOUT_MS);
      const parentAcquiredAt = Date.now();

      expect(parentAcquiredAt - beforeParentAcquire).toBeGreaterThanOrEqual(HOLD_MS - 300);

      releaseIngestConsumerGroupWriterLock();
      await childExited;
    },
    CROSS_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "TC-R (the T-RAP-041 retry-1 regression case): reader-vs-reader is ALSO exclusive across real, separate OS processes — a genuinely non-exclusive reader/writer split was tried and reverted (see this module's own header) because it let two different full-pipeline FILES' own worker bundles race each other's DB rows",
    async () => {
      const HOLD_MS = 1_500;
      const { outcome: childOutcome, exited: childExited } = spawnChild('reader', HOLD_MS);
      const child = await childOutcome;
      expect(child.ok).toBe(true);

      const start = Date.now();
      const lease = await acquireIngestConsumerGroupReaderLease(CROSS_PROCESS_TEST_TIMEOUT_MS);
      // Before the revert, two reader children/leases acquired within ~1s of each other regardless
      // of HOLD_MS — this asserts the opposite: a real wait for the full hold duration.
      expect(Date.now() - start).toBeGreaterThanOrEqual(HOLD_MS - 300);

      lease.release();
      await childExited;
    },
    CROSS_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'TC-R-writer (cross-process, mixed roles): a writer acquire waits for an existing real reader lease held by a different process to release first',
    async () => {
      const HOLD_MS = 1_500;
      const { outcome: readerOutcome, exited: readerExited } = spawnChild('reader', HOLD_MS);
      const reader = await readerOutcome;
      expect(reader.ok).toBe(true);

      const start = Date.now();
      await acquireIngestConsumerGroupWriterLock(CROSS_PROCESS_TEST_TIMEOUT_MS);
      expect(Date.now() - start).toBeGreaterThanOrEqual(HOLD_MS - 300);

      releaseIngestConsumerGroupWriterLock();
      await readerExited;
    },
    CROSS_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'TC-Fair (starvation regression — the T-RAP-056 disqualifying review case): a stranger waiter that arrived first is never starved out by a DIFFERENT process repeatedly, near-zero-delay re-acquiring the same lock ahead of it',
    async () => {
      const ITERATIONS = 4;
      // Generous: gives the stranger's own real, separate OS process (spawned below, while this
      // first hold is still in progress) time to actually start up and register its own ticket well
      // before this first hold ends — the same "don't let contention slack widen the guarantee, only
      // the budget" discipline this suite's own TC-5 header already established.
      const HAMMER_HOLD_MS = 3_000;

      const {
        iterationsSeen,
        firstIterationAcquired,
        exited: hammerExited,
      } = spawnHammer(ITERATIONS, HAMMER_HOLD_MS);

      const first = await firstIterationAcquired;
      expect(first.ok).toBe(true);

      // The stranger arrives WHILE the hammer's own very first hold is still in progress, so its
      // own ticket is older than any of the hammer's later (iteration 2+) re-acquire attempts.
      const strangerStart = Date.now();
      const { outcome: strangerOutcome, exited: strangerExited } = spawnChild(
        'writer',
        500,
        CROSS_PROCESS_TEST_TIMEOUT_MS,
      );
      const stranger = await strangerOutcome;
      expect(stranger.ok).toBe(true);
      const strangerWaitMs = (stranger.acquiredAt ?? 0) - strangerStart;

      await hammerExited;
      await strangerExited;
      const iterations = await iterationsSeen;
      expect(iterations).toHaveLength(ITERATIONS);
      for (const iteration of iterations) {
        expect(iteration.ok).toBe(true);
      }

      // The real assertion: a FAIR queue guarantees the stranger — which arrived after only the
      // FIRST hammer iteration had already started — goes next, strictly before the hammer's OWN
      // second iteration. An unfair, race-based mutex reliably lets the hammer (near-zero retry
      // delay) win every remaining cycle instead, so the stranger would only ever acquire AFTER the
      // hammer's own LAST iteration — this assertion catches exactly that regression.
      const secondHammerAcquiredAt = iterations[1]?.acquiredAt;
      expect(secondHammerAcquiredAt).toBeDefined();
      expect(stranger.acquiredAt).toBeLessThan(secondHammerAcquiredAt as number);
      // Sanity: the stranger genuinely had to wait for the real first hold to elapse, not just win
      // by luck racing its own boot delay.
      expect(strangerWaitMs).toBeGreaterThanOrEqual(HAMMER_HOLD_MS - 500);
    },
    CROSS_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'TC-4 (acquire timeout): a bounded acquire() call rejects, rather than hanging forever, while another real process still holds the lock',
    async () => {
      const HOLD_MS = 3_000;
      const { outcome: childOutcome, exited: childExited } = spawnChild('writer', HOLD_MS);
      const child = await childOutcome;
      expect(child.ok).toBe(true);

      // The 500ms bound here is this assertion's own subject (a deliberately short, real-clock
      // timeout must reject fast) — a real `setTimeout`-based race against the *already-connected*
      // child from this point on, immune to how long the child itself took to spawn/report above, so
      // it stays tight regardless of full-suite CPU contention.
      await expect(acquireIngestConsumerGroupWriterLock(500)).rejects.toThrow(
        /timed out after 500ms waiting for another test file/,
      );

      // Let the child finish and release for real so it doesn't leak into the next test.
      await childExited;
    },
    CROSS_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'TC-5 (stale-lock reclaim): a lock directory left behind by a crashed holder (heartbeat far older than the staleness window) is reclaimed instead of blocking forever',
    async () => {
      // Simulates a process that `mkdirSync`'d the lock and then died before ever calling release() —
      // never happens in this suite's own normal acquire()/release() pairs, so it's constructed by
      // hand here.
      mkdirSync(__testing.lockDir);
      writeFileSync(
        __testing.heartbeatFile,
        JSON.stringify({ pid: -1, updatedAt: Date.now() - (__testing.staleLockMs + 60_000) }),
      );

      const start = Date.now();
      await acquireIngestConsumerGroupWriterLock(CROSS_PROCESS_TEST_TIMEOUT_MS);
      const elapsed = Date.now() - start;

      // Reclaimed well within the acquire budget, not after waiting it out in full — proving
      // "reclaimed promptly on a poll tick", not "reclaimed instantly" (`POLL_INTERVAL_MS` is only
      // 250ms; a real, unfixed full `npm test` run measured this at up to 32s under legitimate CPU
      // contention from dozens of other real Postgres/Kafka worker processes, well above an earlier,
      // tighter 10s bound this test originally shipped with — the actual reclaim mechanism itself
      // never got slower, only this process's own chance to run its next poll tick did). Bounded by
      // half of `CROSS_PROCESS_TEST_TIMEOUT_MS` so this assertion still fails loudly, rather than
      // timing out uninformatively, if the reclaim mechanism itself ever genuinely regresses to "only
      // reclaims after waiting out the full acquire timeout".
      expect(elapsed).toBeLessThan(CROSS_PROCESS_TEST_TIMEOUT_MS / 2);
      releaseIngestConsumerGroupWriterLock();
    },
    CROSS_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'TC-adjacent (must not change): a fresh, non-stale, currently-held lock is never reclaimed early just because another process is waiting',
    async () => {
      const HOLD_MS = 1_200;
      const { outcome: childOutcome, exited: childExited } = spawnChild('writer', HOLD_MS);
      const child = await childOutcome;
      expect(child.ok).toBe(true);

      // Even though a live, healthy holder is only a fraction of a second old (nowhere near
      // `staleLockMs`), this parent still has to wait for the real release — no early reclaim.
      const start = Date.now();
      await acquireIngestConsumerGroupWriterLock(CROSS_PROCESS_TEST_TIMEOUT_MS);
      expect(Date.now() - start).toBeGreaterThanOrEqual(HOLD_MS - 300);

      releaseIngestConsumerGroupWriterLock();
      await childExited;
    },
    CROSS_PROCESS_TEST_TIMEOUT_MS,
  );

  it('TC-adjacent-reader (must not change): releasing a reader lease is idempotent and safe to call more than once', async () => {
    const lease = await acquireIngestConsumerGroupReaderLease();
    lease.release();
    expect(() => lease.release()).not.toThrow();
  });
});
