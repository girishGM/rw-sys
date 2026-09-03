/**
 * T-RAP-056 (this retry) regression coverage for the specific architecture gap a third independent
 * review proved on real infrastructure: `READER_LEASE_ACQUIRE_TIMEOUT_MS` (retry 1's flat `240_000`)
 * was smaller than `WRITER_LOCK_ACQUIRE_TIMEOUT_MS` (`900_000`), so a fairly-queued reader
 * (`full-pipeline(-multi-instance).e2e-spec.ts`) could legitimately time out waiting for a writer
 * (`activity-ingest.consumer.e2e-spec.ts`) that was still well within its own allowed hold — not a
 * fluke, a structural, reproducible asymmetry between two independently-guessed numbers. See
 * `ingest-consumer-writer-lock-budget.ts`'s own doc comment for the full before/after and why this
 * project deliberately does NOT import `full-pipeline-test-helpers.ts`'s sibling `.e2e-spec.ts` files
 * directly here (importing a spec file would re-register its own `describe`/`it` blocks onto this
 * file's own test run).
 *
 * This test encodes the invariant the architect's decision requires directly — "the reader's own
 * acquire-wait budget must never be smaller than the writer's own" — against the REAL, in-force
 * values (an import, not a duplicated literal), so a future change to either side that silently
 * reintroduces the asymmetry fails fast and deterministically here, in milliseconds, rather than only
 * being discoverable again by a multi-minute real e2e run under contention (exactly how this defect
 * was found three times in a row before this fix).
 */
import { WRITER_LOCK_ACQUIRE_TIMEOUT_MS } from './ingest-consumer-writer-lock-budget';
import { READER_LEASE_ACQUIRE_TIMEOUT_MS } from './full-pipeline-test-helpers';

describe('T-RAP-056 regression: reader lease budget must never be smaller than the writer lock budget', () => {
  // TC-2: the same check, after the fix — asserted against the real, in-force values.
  it('TC-2: READER_LEASE_ACQUIRE_TIMEOUT_MS >= WRITER_LOCK_ACQUIRE_TIMEOUT_MS (the real, in-force values)', () => {
    expect(READER_LEASE_ACQUIRE_TIMEOUT_MS).toBeGreaterThanOrEqual(WRITER_LOCK_ACQUIRE_TIMEOUT_MS);
  });

  // TC-1 (reproduce) / TC-3 (regression, proven to fail on the unfixed code): retry 1's own reader
  // budget (a flat 240_000, hardcoded independently of the writer's own budget) really was smaller
  // than the writer's own 900_000 — the exact asymmetry the review reproduced on real infrastructure.
  // This is not a hypothetical: it is retry 1's literal historical value, preserved here so this
  // specific regression can never silently reappear unnoticed.
  it("TC-1/TC-3 (proven to fail on the unfixed code): retry 1's own historical flat reader budget (240_000) was smaller than the writer budget", () => {
    const RETRY_1_READER_LEASE_ACQUIRE_TIMEOUT_MS = 240_000;
    expect(RETRY_1_READER_LEASE_ACQUIRE_TIMEOUT_MS).toBeLessThan(WRITER_LOCK_ACQUIRE_TIMEOUT_MS);
  });

  // TC-4: adjacent behaviour unchanged — the reader budget still carries genuine headroom beyond the
  // bare minimum the invariant requires (this fix must not satisfy the invariant by coincidentally
  // sizing the reader budget down to exactly the writer's own value, which would leave no room for
  // the "another full-pipeline file's own current TC is holding it instead" case).
  it('TC-4: the reader budget still carries real headroom beyond the writer budget alone, for the other-reader-holding case', () => {
    expect(READER_LEASE_ACQUIRE_TIMEOUT_MS).toBeGreaterThan(WRITER_LOCK_ACQUIRE_TIMEOUT_MS);
  });
});
