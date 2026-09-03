/**
 * T-RAP-056 / T-RAP-041 (retry 1). Real, inter-process mutual exclusion for the one Kafka consumer
 * group every real production instance of this service's Kafka ingress joins
 * (`ACTIVITY_INGEST_CONSUMER_GROUP`, `src/messaging/ingest/ingest.config.ts`) — used ONLY by this
 * project's own e2e test harness, never by production code.
 *
 * **The defect this fixes (T-RAP-056).** `activity-ingest.consumer.e2e-spec.ts` (T-RAP-023/
 * T-RAP-055) asserts an EXACT member count (`waitForStableGroupMembership`) for that real, shared
 * group, so its own two test consumers must be the only members while its own tests run.
 * `full-pipeline.e2e-spec.ts` / `full-pipeline-multi-instance.e2e-spec.ts` (T-RAP-041, via this
 * file's own sibling `full-pipeline-test-helpers.ts`'s `startInstance()`) start real consumers that
 * correctly join that SAME real group — genuinely correct, intended production behaviour on its own
 * (`ingest.config.ts`'s own header: "every running instance of this service joins the SAME group").
 * The bug was purely a test-isolation gap: Jest's default multi-worker parallelism can schedule both
 * kinds of file's own real consumers concurrently against the same real local Redpanda, so one
 * file's own consumers get counted by the other file's own exact-membership assertion.
 *
 * **T-RAP-041 retry 1, attempt A (reverted): a reader/writer split.** The first fix (a single global
 * mutex) also serialized `full-pipeline(-multi-instance)`'s OWN instances against EACH OTHER, which
 * nothing about `waitForStableGroupMembership` actually required — an initial rewrite of this module
 * therefore let any number of `startInstance()` "reader" leases coexist, only ever waiting on the one
 * "writer" (`activity-ingest.consumer.e2e-spec.ts`). That DID fix the reported timeout symptom, but
 * independent re-verification (running the exact scoped `npm test -- full-pipeline` command 3 times)
 * found it traded one bug for a WORSE one: it let `full-pipeline.e2e-spec.ts` and
 * `full-pipeline-multi-instance.e2e-spec.ts`'s own real worker bundles run truly concurrently for the
 * first time, and their `ActivityLogClaimWorker`s are each independently, GLOBALLY scoped (claim ANY
 * row from the whole `activity_logs` table, not filtered by tenant OR by which file's own instance
 * ingested it — see `full-pipeline.e2e-spec.ts`'s own header, "the same accepted, already-documented
 * full-parallel-`npm test` contamination risk"). The two files use DIFFERENT
 * `FIELD_ENCRYPTION_AES_KEY`/`FIELD_ENCRYPTION_HMAC_KEY` values (deliberately, so a test in one file
 * can never accidentally pass by reading state a DIFFERENT file's own instance wrote) — so a
 * cross-file claim (file B's claim worker processing file A's own `activity_logs` row) computes that
 * row's `customer_id_hash`/reward encryption with the WRONG key, producing exactly the kind of
 * "reward exists but its `customer_id_hash` doesn't match" failure reproduced directly: TC-1 failed
 * on the 3rd of 3 consecutive scoped runs with `rewardGrpc` (found by the calling test's own,
 * correctly-keyed hash) simply absent while `rewards` still had the expected count — the other row's
 * hash had been computed with a foreign file's key. Confirmed by isolation: each file run ALONE, 3
 * times each, was 100% clean; only concurrent-across-files runs reproduced it. This hazard is
 * independent of Kafka consumer-group membership entirely (`ActivityLogClaimWorker` claims via a real
 * DB row lock, nothing to do with the group) — it was only ever *accidentally* prevented before by
 * the original single mutex's own overly-broad scope (it happened to serialize each `startInstance()`
 * call's ENTIRE lifetime — Kafka ingress AND the worker bundle alike — not just the Kafka join).
 * `ActivityLogClaimWorker` itself is owned by `agent-rap-processing` (`src/modules/processing/**`),
 * outside this task's file scope, so tenant-scoping it there is not an option here.
 *
 * **T-RAP-041 retry 1, attempt B (kept): back to one mutex, correctly bounded.** Given full mutual
 * exclusion between different FILES' own worker bundles is a genuine, non-negotiable safety
 * requirement (not just a Kafka-membership nicety), this module is ONE reentrant, cross-process
 * exclusive lock again — reader/writer are still exposed as two differently-named entry points purely
 * for callers' own documentation clarity (`activity-ingest.consumer.e2e-spec.ts`'s "I am the one
 * writer" vs `full-pipeline-test-helpers.ts`'s "I am one of possibly several readers"), but they share
 * the exact same underlying mutex and reentrant counter. Reentrancy is still what lets
 * `full-pipeline-multi-instance.e2e-spec.ts`'s own legitimate "two real instances at once" scenario
 * call `startInstance()` twice, sequentially, in the SAME process, without its own second call
 * blocking on its own first (Jest itself already guarantees no two `it()`s in the SAME file run
 * concurrently, so reentrancy only ever needs to reason about that one, single-process, "nested
 * within one test" case — never about two different files/processes).
 *
 * What actually fixes the review's ORIGINAL timeout complaint, without reopening the correctness
 * hole above: each caller now passes an explicit acquire-timeout budget kept safely BELOW its own
 * file's `jest.setTimeout` (see `full-pipeline-test-helpers.ts`'s and
 * `activity-ingest.consumer.e2e-spec.ts`'s own call sites) — the module's old 240s default could
 * exceed `full-pipeline.e2e-spec.ts`'s own 180s per-test budget outright, turning a bounded, legitimate
 * wait into an opaque, generic Jest "Exceeded timeout" instead of this lock's own clear, attributable
 * error. Measured combined solo runtime for both full-pipeline files together is well under two
 * minutes, so a real, correctness-required serialization between them fits comfortably inside a
 * 120s-per-acquire budget under normal (non-multi-agent-contended) conditions.
 *
 * **T-RAP-056 retry 1 (this change): a real reviewer re-run disqualified the above.** Re-running the
 * exact reported 3-file command twice from clean baselines reproduced BOTH the already-known
 * T-RAP-041 flakiness (not charged here) AND a second, disqualifying failure squarely in this
 * module's own territory: `activity-ingest.consumer.e2e-spec.ts`'s entire suite failed outright with
 * `acquireIngestConsumerGroupWriterLock: timed out after 75000ms`. Root cause: the mutex above was a
 * plain "whoever calls `mkdirSync` first, wins" race with NO notion of arrival order. Under
 * `full-pipeline-multi-instance.e2e-spec.ts`'s own real usage pattern — several *sequential* per-TC
 * `startInstance()`/`close()` cycles in ONE process, each re-acquiring the SAME mutex essentially
 * back-to-back (near-zero gap between one TC's own release and the next TC's own re-acquire) — that
 * repeat-re-acquirer has a structural, near-zero-latency advantage over a DIFFERENT process/file that
 * is only ever polling on `POLL_INTERVAL_MS`: every single time the lock frees, the repeat-re-acquirer
 * can attempt `mkdirSync` again almost instantly, while the other waiter's next attempt is still up to
 * a full poll tick away. Over several TCs in a row this reliably starves the other waiter out — not a
 * probabilistic fluke, a structural asymmetry (proved deterministically by this file's own regression
 * suite's "TC-Fair" case, engineered to reproduce exactly this pattern). A bigger flat timeout alone
 * cannot fix this: no matter how large the budget, a starved waiter still never gets a turn as long as
 * every retry keeps losing the same race. The actual fix has two parts:
 *
 * 1. **A real FIFO queue, not a race.** Every waiter first drops a "ticket" file (its own arrival
 *    time) into `QUEUE_DIR`, then is only *permitted* to attempt `mkdirSync` once it is the OLDEST
 *    live ticket present — see `createTicket`/`readQueue`/`isQueueHead` below. This makes arrival
 *    order, not raw retry speed, decide who goes next: `full-pipeline-multi-instance.e2e-spec.ts`'s
 *    own later, same-process re-acquire always creates a ticket dated AFTER an already-waiting
 *    stranger's own earlier ticket, so it is never allowed to even try until that earlier ticket has
 *    gone first. **Mutual exclusion itself never depends on the queue being correct** — `mkdirSync`'s
 *    own EEXIST race-freedom is the only thing that actually guarantees "only one holder"; the queue
 *    only ever influences who is *permitted to attempt* it, so even a queue-ordering bug could change
 *    fairness, never break exclusivity.
 * 2. **A ticket's own liveness heartbeat, so a dead head can't wedge everyone else.** Strictly
 *    honouring "only the head may attempt" would let a ticket belonging to a since-crashed process
 *    block every other waiter indefinitely. Each ticket refreshes its own `heartbeatAt` every poll
 *    tick (same rhythm as the lock's own holder heartbeat below); a ticket whose heartbeat has gone
 *    quiet for longer than `ABANDONED_TICKET_MS` is treated as abandoned and skipped when computing
 *    who's next — comfortably above the ~32s worst poll-tick delay this project has already measured
 *    under real full-suite CPU contention (see `activity-ingest.consumer.e2e-spec.ts`'s own T-RAP-055
 *    header), so a merely-slow-but-alive waiter is never mistaken for a dead one.
 *
 * Alongside the structural fix, every call site's own acquire-timeout budget (and the corresponding
 * `jest.setTimeout`) was also raised to a value derived from real arithmetic, not guessed: see
 * `full-pipeline-test-helpers.ts`'s and `activity-ingest.consumer.e2e-spec.ts`'s own call sites for
 * the worked-out numbers. Fairness bounds *who* goes next; a large-enough budget is still what bounds
 * *how long* a fairly-queued caller is willing to wait its turn.
 *
 * **T-RAP-056 retry 2: retry 1's own "large-enough budget" was two independently-guessed numbers,
 * and they were not symmetrically safe.** A second independent review re-ran the exact reported
 * command twice from clean baselines and reproduced real, disqualifying failures retry 1's own
 * verification never caught: `activity-ingest.consumer.e2e-spec.ts` (the "writer" role) legitimately
 * held this lock for **502s** in one of those runs — its own `beforeAll` membership-stability wait
 * plus every one of its own `it()` tests, ALL of which run while still holding the lock (see this
 * module's own "why the whole lifetime" reasoning above; a mid-suite membership change would
 * invalidate TC-5's own partition-split assumption) — while `full-pipeline-test-helpers.ts`'s own
 * "reader" budget was a flat 240s, guessed independently from this file's own worst case rather than
 * from the writer's own real one. Fairness (retry 1's fix) guarantees a reader is never STARVED
 * behind a same-process repeat re-acquirer; it says nothing about how long a *legitimately, fairly
 * queued* reader may need to wait for a slow-but-alive holder to finish real work no timeout should
 * interrupt. `MAX_REALISTIC_LOCK_HOLD_MS` below is now the ONE place that arithmetic lives — every
 * caller's own acquire-timeout budget is derived FROM it (an import, not a re-guessed literal), so
 * the two sides can never independently drift apart again the way they just did.
 *
 * **Cross-process primitives:**
 * 1. `mkdirSync` (WITHOUT `recursive: true` on the lock directory itself — see `tryAcquireMarker`'s
 *    own comment for why that flag would silently defeat the whole guarantee) is atomic
 *    create-if-absent on both POSIX and Windows, so "the directory now exists" is an unambiguous,
 *    race-free "I hold it" signal shared by every OS process (every Jest worker) pointed at the same
 *    `os.tmpdir()` path.
 * 2. A periodic heartbeat file + a generous `STALE_LOCK_MS` age check lets a crashed holder's marker
 *    be reclaimed instead of wedging every future run forever.
 * 3. The FIFO queue directory (`QUEUE_DIR`) uses the exact same "one file per participant, best-effort
 *    cleanup, heartbeat-based abandonment" shape as the lock marker itself, for the same reasons.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * T-RAP-056 (this retry). `RAP_E2E_LOCK_ROOT_DIR` is an internal, test-only escape hatch — never set
 * by any real `activity-ingest.consumer.e2e-spec.ts`/`full-pipeline(-multi-instance).e2e-spec.ts` run,
 * which all rely on the unset default (`tmpdir()`, unchanged) to share the one real lock directory
 * that makes cross-file mutual exclusion mean anything.
 *
 * This exists solely so `kafka-shared-consumer-group-lock.spec.ts` — this module's OWN regression
 * spec — can point its real child-process acquisitions and its own `resetIngestConsumerGroupLockForTests()`
 * calls at an ISOLATED directory instead of the real shared one. Root-caused during this retry's own
 * full, unfiltered `npm test` gate run: that regression spec's `beforeEach`/`afterEach` unconditionally
 * `rmSync`s the real `LOCK_DIR`/`QUEUE_DIR` to reset its own in-process state between its own tests —
 * safe when it is the only thing touching those paths, but when Jest schedules it in a separate worker
 * process CONCURRENTLY with a real `activity-ingest.consumer.e2e-spec.ts` writer (now legitimately
 * holding the SAME real, hardcoded path for up to `MAX_REALISTIC_LOCK_HOLD_MS`, since this task's own
 * retry 2 raised that budget), this spec's own cleanup could rip the lock out from under a real,
 * currently-holding process — reopening the exact cross-file `ActivityLogClaimWorker` correctness
 * hazard (wrong-file `FIELD_ENCRYPTION_*` keys) this whole module exists to prevent (see this file's
 * own header above). A real, reproducible `acquireIngestConsumerGroupReaderLease: timed out after
 * 90000ms ... (queue position 1 of 2 (0 still ahead))` failure inside the regression spec itself,
 * during that same full-suite run, is what surfaced the shared-path interference in the first place.
 * Giving the regression spec its own isolated root (a fresh `mkdtempSync` per run, see that file's own
 * `beforeAll`) removes the interference at its actual source — sharing mutable global filesystem state
 * between a mechanism's OWN regression test and real, unrelated production-shaped usage of that exact
 * mechanism — rather than trying to out-guess a "safe" timeout for an unbounded, contention-shaped
 * real hold this spec's own fast, deterministic tests were never meant to wait behind at all.
 */
const LOCK_ROOT_DIR = process.env.RAP_E2E_LOCK_ROOT_DIR ?? tmpdir();
const LOCK_DIR = join(LOCK_ROOT_DIR, 'rap-e2e-activity-ingest-consumer-group.lock');
const HEARTBEAT_FILE = join(LOCK_DIR, 'heartbeat.json');
const QUEUE_DIR = join(LOCK_ROOT_DIR, 'rap-e2e-activity-ingest-consumer-group.queue');
const DEFAULT_ACQUIRE_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 250;
const HEARTBEAT_INTERVAL_MS = 10_000;
/** Any lock whose heartbeat is older than this is assumed abandoned by a process that never got to
 * release it cleanly (killed, crashed) and is force-reclaimed rather than blocking forever. Well
 * above `HEARTBEAT_INTERVAL_MS` and above this file's own `DEFAULT_ACQUIRE_TIMEOUT_MS` so a live
 * holder's own heartbeat never comes close to it under normal operation. */
const STALE_LOCK_MS = 5 * 60_000;
/** A queued ticket whose own `heartbeatAt` (refreshed every `POLL_INTERVAL_MS` while its owner is
 * still actually waiting) is older than this is treated as abandoned and skipped when deciding who's
 * next in line — see this module's own header, point 2. Comfortably above the ~32s worst poll-tick
 * delay this project has already measured under real full-suite CPU contention, so a merely slow
 * (not dead) waiter's own ticket is never mistaken for an abandoned one. */
const ABANDONED_TICKET_MS = 60_000;

/**
 * T-RAP-056 retry 2. The realistic worst-case duration any ONE caller can legitimately HOLD this
 * lock once acquired, before releasing it — this is deliberately NOT an acquire-wait budget (see
 * `DEFAULT_ACQUIRE_TIMEOUT_MS` / each call site's own override for that half of the arithmetic); it
 * is the OTHER half a waiter needs: even once FIFO fairness guarantees I am correctly queued and
 * next in line, how long could the CURRENT holder legitimately still be running?
 *
 * The longest legitimate single hold in this lock's own 3-file topology belongs to
 * `activity-ingest.consumer.e2e-spec.ts`'s own "writer" role, because (unlike a "reader" lease,
 * held only for one `startInstance()`/`close()` cycle at a time) it holds this lock for its ENTIRE
 * `describe` block's lifetime — deliberately, see this module's own header above. Worked out from
 * that file's own real, worst-case per-test budgets (that file remains the authoritative source for
 * each individual number; this comment only sums them so the arithmetic is auditable from here
 * without re-deriving it — if that file's own budgets change, this constant must move with them,
 * and that file's own header cross-references this one for exactly that reason):
 * `waitForStableGroupMembership`'s own 45s budget + 4 tests at that file's shared 90s
 * `jest.setTimeout` default (TC-1..TC-4) + TC-6's own 150s override + TC-5's own 150s override =
 * 45 + 360 + 150 + 150 = 705s. Rounded up to 900s for headroom (≈28%, comfortably above even the
 * 502s a real independent review actually measured on real full-suite contention) — a caller-
 * agnostic ceiling every waiter's own acquire-timeout budget is derived from below, not re-guessed.
 */
export const MAX_REALISTIC_LOCK_HOLD_MS = 900_000;

let reentrantCount = 0;
let heartbeatTimer: NodeJS.Timeout | undefined;

interface Ticket {
  readonly path: string;
  readonly name: string;
  readonly createdAt: number;
}

function ensureQueueDir(): void {
  try {
    mkdirSync(QUEUE_DIR, { recursive: true });
  } catch {
    // Already exists — expected; this directory is intentionally shared/created by many processes.
  }
}

/** Creates this caller's own ticket: `<createdAt padded>-<pid>-<random>.json`, so every process
 * listing `QUEUE_DIR` derives the identical arrival order from the filename/content alone — no
 * shared in-memory counter is possible across separate OS processes. */
function createTicket(): Ticket {
  ensureQueueDir();
  const createdAt = Date.now();
  const name = `${String(createdAt).padStart(15, '0')}-${process.pid}-${randomBytes(4).toString('hex')}.json`;
  const path = join(QUEUE_DIR, name);
  writeFileSync(path, JSON.stringify({ pid: process.pid, createdAt, heartbeatAt: createdAt }));
  return { path, name, createdAt };
}

/** Refreshes this ticket's own liveness heartbeat. Best-effort: a failed write can only ever make
 * this ticket look abandoned to someone else *early*, never cause two tickets to be treated as the
 * same one — see this module's own header, point 2. */
function touchTicket(ticket: Ticket): void {
  try {
    writeFileSync(
      ticket.path,
      JSON.stringify({ pid: process.pid, createdAt: ticket.createdAt, heartbeatAt: Date.now() }),
    );
  } catch {
    // Best-effort only — see doc comment above.
  }
}

function removeTicket(ticket: Ticket): void {
  try {
    rmSync(ticket.path, { force: true });
  } catch {
    // Already gone (e.g. this ticket was itself reaped as abandoned in the meantime) — fine.
  }
}

/** Reads every currently-live ticket, oldest first. Silently skips (and best-effort deletes) any
 * ticket whose own heartbeat has gone stale — see `ABANDONED_TICKET_MS`'s own doc comment — and any
 * file that is unreadable/mid-write on this particular poll tick (it will resolve, or get reaped as
 * abandoned, on a later one). */
function readQueue(): Ticket[] {
  let names: string[];
  try {
    names = readdirSync(QUEUE_DIR);
  } catch {
    return [];
  }
  const tickets: Ticket[] = [];
  for (const name of names) {
    const path = join(QUEUE_DIR, name);
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as { createdAt: number; heartbeatAt?: number };
      const heartbeatAt =
        typeof parsed.heartbeatAt === 'number' ? parsed.heartbeatAt : parsed.createdAt;
      if (Date.now() - heartbeatAt > ABANDONED_TICKET_MS) {
        try {
          rmSync(path, { force: true });
        } catch {
          // Lost the race to reap it (another process reaped or its own owner removed it first).
        }
        continue;
      }
      tickets.push({ path, name, createdAt: parsed.createdAt });
    } catch {
      // Unreadable/mid-write right now — skip this poll tick only.
    }
  }
  // Arrival order is the ticket's own recorded `createdAt`; the filename (which embeds `pid` and a
  // random suffix) only ever breaks an exact-millisecond tie, deterministically, the same way for
  // every process reading this same directory listing.
  tickets.sort((a, b) => a.createdAt - b.createdAt || (a.name < b.name ? -1 : 1));
  return tickets;
}

function isQueueHead(ticket: Ticket): boolean {
  const queue = readQueue();
  return queue.length > 0 && queue[0].name === ticket.name;
}

/** Diagnostics for a timed-out acquire — reports queue depth so a future investigation doesn't have
 * to start from zero the way T-RAP-056's own review did. */
function describeQueueForError(ticket: Ticket): string {
  const queue = readQueue();
  const position = queue.findIndex((entry) => entry.name === ticket.name);
  if (position === -1) {
    return `own ticket no longer visible in a queue of ${queue.length}`;
  }
  return `queue position ${position + 1} of ${queue.length} (${position} still ahead)`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeHeartbeat(): void {
  try {
    writeFileSync(HEARTBEAT_FILE, JSON.stringify({ pid: process.pid, updatedAt: Date.now() }));
  } catch {
    // Best-effort only: a failed heartbeat write can only make this lock look stale to someone
    // else *early*, never cause two holders to believe they both hold it — the reclaiming side
    // always re-`mkdirSync`s atomically before deciding it "won" (see `tryAcquireMarker`).
  }
}

function isStale(): boolean {
  try {
    const raw = readFileSync(HEARTBEAT_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { updatedAt: number };
    return Date.now() - parsed.updatedAt > STALE_LOCK_MS;
  } catch {
    // Missing/unparseable heartbeat is expected for the brief window between a fresh `mkdirSync`
    // and that same holder's first `writeHeartbeat()` — treat as "not proven stale yet", not stale.
    return false;
  }
}

function tryAcquireMarker(): boolean {
  try {
    mkdirSync(LOCK_DIR);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    if (isStale()) {
      try {
        rmSync(LOCK_DIR, { recursive: true, force: true });
      } catch {
        // Lost the race to reclaim it (another process reclaimed or released it first) — fall
        // through and let the next poll interval retry the normal way.
      }
    }
    return false;
  }
}

async function acquire(callerLabel: string, timeoutMs: number): Promise<void> {
  if (reentrantCount > 0) {
    reentrantCount += 1;
    return;
  }
  const deadline = Date.now() + timeoutMs;
  // T-RAP-056 retry 1: FIFO fairness — this ticket records our own arrival time, and only the
  // OLDEST live ticket is permitted to attempt `tryAcquireMarker()` on any given poll tick, so a
  // repeat re-acquirer (e.g. `full-pipeline-multi-instance.e2e-spec.ts`'s own several sequential
  // per-TC `startInstance()`/`close()` cycles) can never keep winning a bare "whoever calls
  // `mkdirSync` first" race against a stranger who arrived first but only polls on
  // `POLL_INTERVAL_MS` — see this module's own header for the full diagnosis.
  const ticket = createTicket();
  try {
    while (true) {
      touchTicket(ticket);
      if (isQueueHead(ticket) && tryAcquireMarker()) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `${callerLabel}: timed out after ${timeoutMs}ms waiting for another test file's own real ` +
            'consumer(s)/worker bundle to leave the shared Kafka consumer group ' +
            `(${describeQueueForError(ticket)})`,
        );
      }
      await wait(POLL_INTERVAL_MS);
    }
  } finally {
    // Whether we just acquired the actual lock (no longer need a queue placeholder) or gave up
    // (timed out), our own ticket must never linger in the queue for someone else to wait behind.
    removeTicket(ticket);
  }
  reentrantCount = 1;
  writeHeartbeat();
  heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);
  // Never keeps the test process alive on its own — this lock always lives strictly inside a
  // bounded describe block's own beforeAll/afterAll (or a single test's own try/finally) lifetime.
  heartbeatTimer.unref();
}

function release(): void {
  if (reentrantCount === 0) {
    return;
  }
  reentrantCount -= 1;
  if (reentrantCount > 0) {
    return;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  try {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    // Already gone (e.g. reclaimed as stale by someone else in the meantime) — nothing left to do.
  }
}

/**
 * Acquires exclusive, cross-process access to the shared Kafka consumer group for the calling
 * process. Reentrant within one process: a second (or third...) call before the first is released
 * never blocks on this process's own already-held lock — it only increments an in-process counter
 * — so a single test's own legitimate multi-instance scenario never deadlocks itself. Every
 * `acquire...()` call must be matched by exactly one `release...()` call.
 *
 * Named for `activity-ingest.consumer.e2e-spec.ts`'s own role (the one caller whose own
 * `waitForStableGroupMembership` genuinely needs to see nobody else present) — see this module's own
 * header for why `acquireIngestConsumerGroupReaderLease()` below shares this exact same mechanism
 * rather than a weaker one.
 */
export async function acquireIngestConsumerGroupWriterLock(
  timeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS,
): Promise<void> {
  await acquire('acquireIngestConsumerGroupWriterLock', timeoutMs);
}

/**
 * Releases one previously-acquired hold. Safe to call even when nothing is currently held (a no-op)
 * so a spec file's own `afterAll`/`finally` cleanup never itself throws when an earlier `beforeAll`
 * failed before ever acquiring the lock.
 */
export function releaseIngestConsumerGroupWriterLock(): void {
  release();
}

export interface IngestConsumerGroupReaderLease {
  /** Releases this one lease. Idempotent — safe to call more than once. */
  release(): void;
}

/**
 * Acquires exclusive, cross-process access to the shared Kafka consumer group for the calling
 * process, on behalf of one `startInstance()` bundle (`full-pipeline-test-helpers.ts`). Despite the
 * "reader" name (kept for documentation clarity about the caller's own role, and because it returns a
 * lease object rather than needing a separately-matched `release...()` call), this shares the exact
 * same cross-process-exclusive mechanism as `acquireIngestConsumerGroupWriterLock()` above — see this
 * module's own header for why a genuinely non-exclusive reader/writer split was tried and reverted.
 * Reentrant within one process (see `acquireIngestConsumerGroupWriterLock`'s own doc comment) — a
 * second lease acquired by the SAME process (e.g. `full-pipeline-multi-instance.e2e-spec.ts`'s own
 * two, sequential, single-test `startInstance()` calls) never blocks on the first.
 */
export async function acquireIngestConsumerGroupReaderLease(
  timeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS,
): Promise<IngestConsumerGroupReaderLease> {
  await acquire('acquireIngestConsumerGroupReaderLease', timeoutMs);
  let released = false;
  return {
    release(): void {
      if (released) {
        return;
      }
      released = true;
      release();
    },
  };
}

/** Test-only escape hatch: resets in-process state and drops any real lock this process holds,
 * without requiring every matching `release...()` call — used by this file's own regression spec so
 * one test's failure can't leave `reentrantCount` desynced for the next. Never used by a real
 * full-pipeline/ingest-consumer spec file. */
export function resetIngestConsumerGroupLockForTests(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  reentrantCount = 0;
  try {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    // Nothing to remove — already clear.
  }
  try {
    rmSync(QUEUE_DIR, { recursive: true, force: true });
  } catch {
    // Nothing to remove — already clear.
  }
}

/** Test-only: exposes the module's own internal path/threshold constants so this file's own
 * regression spec can set up a synthetic stale-lock scenario without duplicating (and risking a
 * silent drift from) the real values above. Never imported by a real full-pipeline/ingest-consumer
 * spec file. */
export const __testing = {
  lockDir: LOCK_DIR,
  heartbeatFile: HEARTBEAT_FILE,
  staleLockMs: STALE_LOCK_MS,
  queueDir: QUEUE_DIR,
  abandonedTicketMs: ABANDONED_TICKET_MS,
};
