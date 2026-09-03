/**
 * T-RAP-056 (this retry). Single source of truth for
 * `activity-ingest.consumer.e2e-spec.ts`'s own "writer" acquire-wait budget for
 * `kafka-shared-consumer-group-lock.ts`'s shared mutex — pulled out of that spec file into its own
 * tiny, non-spec module specifically so both sides of the reader/writer relationship this task's own
 * review flagged can import the identical value rather than each hardcoding a literal that only
 * *happens* to agree today.
 *
 * **Why this file exists at all (the actual defect, twice now).** Retry 1 introduced
 * `READER_LEASE_ACQUIRE_TIMEOUT_MS` (`full-pipeline-test-helpers.ts`) as a flat `240_000`, guessed
 * independently of `WRITER_LOCK_ACQUIRE_TIMEOUT_MS` (then also a flat literal in the ingest-consumer
 * spec file, `900_000`). An independent review measured the writer's own real hold at 502s and
 * reproduced genuine reader-lease timeouts as a direct, reproducible result — not a fluke, a
 * structural asymmetry between two independently-guessed numbers. Retry 2 fixed the reader side by
 * deriving it from `MAX_REALISTIC_LOCK_HOLD_MS` (this lock module's own worked-out real-arithmetic
 * constant) — but left the writer side as a bare `900_000` literal that only *coincidentally* equalled
 * `MAX_REALISTIC_LOCK_HOLD_MS`. That is exactly the shape the architect's decision called out by name
 * ("two independently-guessed numbers... Do not simply raise both numbers without linking them — that
 * just moves the same asymmetry to a longer timescale"): nothing stopped a future change to either
 * number from silently reintroducing the identical asymmetry, just at a larger scale.
 *
 * **The actual fix.** `WRITER_LOCK_ACQUIRE_TIMEOUT_MS` below is now an import of
 * `MAX_REALISTIC_LOCK_HOLD_MS`, not a re-guessed literal — comfortably above the ~400_000ms this
 * constant's own worked arithmetic in `activity-ingest.consumer.e2e-spec.ts`'s own history actually
 * needs (at most two other waiters, each up to `OTHER_READER_FILE_MAX_HOLD_MS`-worth of real work).
 * `full-pipeline-test-helpers.ts`'s own `READER_LEASE_ACQUIRE_TIMEOUT_MS` now imports THIS constant
 * directly (see that file's own doc comment), so both sides trace back to the exact same value and can
 * never independently drift apart again — the literal fix the architect's decision asked for, not
 * "raise both numbers and hope they stay in sync."
 *
 * See `lock-budget-invariant.spec.ts` for the regression test that encodes "reader budget must never
 * be smaller than the writer's" directly, so this relationship failing to hold is a fast, deterministic
 * unit-test failure the next time either side changes — not something that can only be discovered again
 * by a real, multi-minute e2e run under contention.
 */
import { MAX_REALISTIC_LOCK_HOLD_MS } from './kafka-shared-consumer-group-lock';

export const WRITER_LOCK_ACQUIRE_TIMEOUT_MS = MAX_REALISTIC_LOCK_HOLD_MS;
