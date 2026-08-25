/**
 * T-045 — the fixed numbers 08-OBSERVABILITY.md §6 and the task file pin, in one place so a
 * test and the code it tests read the same constant rather than two copies of "5000" or "0.25".
 */

/**
 * Implementation note 8 — *"refuse to assemble more than 5,000 rows across sources, returning a
 * truncation notice rather than timing out."*
 *
 * Applied as a shared budget across all four sources (`trace-assembly.ts`'s `RowBudget`), not as
 * a per-source cap: "across sources" is the document's own word, and a per-source 5,000 would let
 * four sources return 20,000 rows between them while each individually stayed under the number
 * the task file names.
 */
export const MAX_TRACE_ROWS = 5000;

/**
 * Implementation note 6 — *"slow spans (> 25% of total) highlighted."*
 *
 * A ratio of the request's total duration, not an absolute millisecond threshold: a 5 ms span is
 * unremarkable in a 20 ms request and alarming in a 6 ms one, and §5's own worked example
 * (`notify.checkers`, 98 ms of a 142 ms request — 69%) is highlighted precisely because it
 * dominates the request, not because 98 ms crosses some fixed line.
 */
export const SLOW_SPAN_RATIO = 0.25;

/** 08-OBSERVABILITY.md §1, and `common/errors/trace-id.ts`'s `CORRELATION_ID_PATTERN` verbatim.
 * Not imported from there: this module's own contract test
 * (`test/trace/correlation-id-pattern.spec.ts`) asserts the two — and the shared package's copy —
 * stay identical, which is a stronger guarantee against silent drift than a single import site. */
export const TRACE_CORRELATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** The `msg` values `logger.config.ts`'s `CorrelationMiddleware` writes for a finished request. */
export const REQUEST_COMPLETION_MESSAGES = Object.freeze(['request completed', 'request aborted']);
