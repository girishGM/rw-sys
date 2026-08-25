/**
 * T-019 — the request timeline of 08-OBSERVABILITY.md §5.
 *
 * > ```
 * > POST /api/v1/campaigns/8821/submit          correlationId 01J8F3K9QP2M7N     142ms
 * > ├─ csrf.verify                      0.2ms  ✓
 * > ├─ jwt.verify                       0.8ms  ✓  sub=42 role=maker
 * > ├─ session.validate                 2.1ms  ✓  sid=… (db)
 * > …
 * > ```
 * >
 * > *"The `⚠ slow` marker on notification is the kind of finding this view surfaces in seconds
 * > and that averages hide completely."*
 *
 * ---
 *
 * ## Why the primary API is a free function, not this injectable service
 *
 * {@link traceSpan} is a module-level function that takes no dependencies and needs no
 * constructor. That is a deliberate design decision with a concrete justification, not a
 * stylistic one:
 *
 * The stages §5 wants timed are the **security chain** — `CsrfGuard`, `JwtAuthGuard`,
 * `SessionValidGuard`, `PermissionsGuard`, `TenancyScopeInterceptor`, the payload interceptors.
 * Every one of them is a finished, 100%-covered component owned by an earlier task. Instrumenting
 * them through DI would mean adding a constructor parameter to each, which changes the signature
 * every existing spec constructs them with — a large, risky diff across six completed tasks in
 * service of a log line. A free function that reads the ambient `AsyncLocalStorage` adds **one
 * line** per component and changes no signature.
 *
 * The second reason matters more: `traceSpan` is a **no-op when no trace is established**. It
 * returns `fn()` unchanged — same value, same exception, same synchronous/asynchronous shape. So
 * an instrumented guard behaves identically in every unit test that never establishes a trace,
 * and tracing can never be the reason a guard decides differently.
 *
 * {@link SpanService} exists for the code that genuinely wants an injectable (Wave 3 services,
 * and T-045 which reads timelines back) and is a thin delegation to the same functions.
 *
 * ## Overhead
 *
 * TC-19 budgets **< 2 ms p95** for the whole tracing layer. One span is two `process.hrtime
 * .bigint()` calls, one object literal and one array push — tens of nanoseconds. The budget is
 * spent almost entirely on JSON-serialising the completion log line, which is why the span list
 * is bounded ({@link MAX_SPANS_PER_REQUEST}) and why attributes are documented as small scalars
 * rather than payloads.
 */
import { Injectable } from '@nestjs/common';
import { HttpException, HttpStatus } from '@nestjs/common';
import { newSpanId } from './otel';
import {
  TraceContext,
  appendSpan,
  elapsedMsSince,
  type RequestTrace,
  type SpanRecord,
  type SpanStatus,
} from './trace-context';

/** Attribute values are scalars only: this ends up in a log line, so it must not be a payload. */
export type SpanAttributes = Readonly<Record<string, string | number | boolean | null>>;

/** An open span. `end` is idempotent — a double-end records one row, not two. */
export interface Span {
  readonly name: string;
  readonly spanId: string;
  end(status?: SpanStatus, attributes?: SpanAttributes): void;
}

/**
 * The names of the security-chain stages, spelled exactly as 08-OBSERVABILITY.md §5 spells them.
 *
 * Constants rather than string literals at the call sites because these names are the **join key**
 * of every aggregation built on top of the timeline: one component typing `jwt.verified` instead
 * of `jwt.verify` splits a dashboard silently. `response.mask` and `response.encrypt` are two
 * spans where §5's diagram draws one line (`response.mask + encrypt`), because they are two
 * separate interceptors and knowing which of them is slow is the entire point of the view.
 */
export const CHAIN_SPAN = Object.freeze({
  CSRF_VERIFY: 'csrf.verify',
  JWT_VERIFY: 'jwt.verify',
  SESSION_VALIDATE: 'session.validate',
  PERMISSION_CHECK: 'permission.check',
  SCOPE_RESOLVE: 'scope.resolve',
  PAYLOAD_DECRYPT: 'payload.decrypt',
  AUDIT_WRITE: 'audit.write',
  RESPONSE_MASK: 'response.mask',
  RESPONSE_ENCRYPT: 'response.encrypt',
});

/** The span name every database statement is recorded under. See `sql-comment.hook.ts`. */
export const DB_SPAN_PREFIX = 'db.';

/**
 * A span that records nothing, returned outside a request.
 *
 * A shared frozen instance rather than a fresh object per call: this is the hot path for every
 * unit test in the codebase, and allocating a throwaway object to immediately discard it is the
 * kind of cost that only shows up in aggregate.
 */
const NOOP_SPAN: Span = Object.freeze({
  name: '',
  spanId: '',
  end: (): void => undefined,
});

/**
 * Opens a span on the current trace, or returns a no-op one when there is no trace.
 *
 * Prefer {@link traceSpan}, which cannot leak an unclosed span. Use this only where start and end
 * genuinely live in different functions.
 */
export function startSpan(name: string, attributes?: SpanAttributes): Span {
  const trace = TraceContext.current();
  if (trace === undefined) return NOOP_SPAN;
  return openSpan(trace, name, attributes);
}

/**
 * Runs `fn` inside a span named `name`, and records how long it took and how it ended.
 *
 * Total and transparent, in the precise sense that matters for instrumenting a guard:
 *
 *  - the return value is `fn`'s, unchanged;
 *  - a thrown error propagates unchanged, after the span is closed as `error` or `denied`;
 *  - a returned promise is awaited for *timing only* — the same promise's settlement is passed
 *    through, so a caller that does not await still gets what it would have got;
 *  - with no trace established it is exactly `fn()`, with no allocation and no branch taken.
 *
 * A 4xx authorisation outcome closes the span as `denied` rather than `error`, because a guard
 * refusing a request is the chain working, and a timeline that paints every denial red is one
 * nobody can read during an incident.
 */
export function traceSpan<T>(name: string, fn: () => T, attributes?: SpanAttributes): T {
  const trace = TraceContext.current();
  if (trace === undefined) return fn();

  const span = openSpan(trace, name, attributes);

  let result: T;
  try {
    result = fn();
  } catch (error) {
    span.end(statusOf(error));
    throw error;
  }

  if (isThenable(result)) {
    // The cast is the one place this file asserts something the type system cannot check: `T` is
    // known to be a thenable here, and `then` returns a promise settling identically, so the
    // result is assignable to `T`. Confined to one line rather than repeated at call sites
    // (R8 — no `any`; `unknown` is narrowed by the cast).
    return result.then(
      (value: unknown) => {
        span.end('ok');
        return value;
      },
      (error: unknown) => {
        span.end(statusOf(error));
        throw error;
      },
    ) as unknown as T;
  }

  span.end('ok');
  return result;
}

/**
 * Records an already-measured span. For instrumentation that times its own work — the Sequelize
 * hook, which is handed a duration by the ORM rather than wrapping a call.
 */
export function recordSpan(
  name: string,
  durationMs: number,
  status: SpanStatus = 'ok',
  attributes?: SpanAttributes,
): void {
  const trace = TraceContext.current();
  if (trace === undefined) return;

  appendSpan(trace, {
    name,
    startedAtMs: Math.max(0, elapsedMsSince(trace.startedAtNs) - durationMs),
    durationMs,
    status,
    spanId: newSpanId(),
    ...(attributes === undefined ? {} : { attributes }),
  });
}

/** The §5 timeline for the current request, in completion order. Empty outside a request. */
export function currentTimeline(): readonly SpanRecord[] {
  return TraceContext.current()?.spans ?? [];
}

/**
 * The injectable form, for code that prefers a dependency to a free function.
 *
 * It holds no state of its own — the state is the request's trace — so it is a singleton and
 * safe to inject anywhere, including into a request-scoped consumer.
 */
@Injectable()
export class SpanService {
  /** @see startSpan */
  start(name: string, attributes?: SpanAttributes): Span {
    return startSpan(name, attributes);
  }

  /** @see traceSpan */
  measure<T>(name: string, fn: () => T, attributes?: SpanAttributes): T {
    return traceSpan(name, fn, attributes);
  }

  /** @see recordSpan */
  record(
    name: string,
    durationMs: number,
    status: SpanStatus = 'ok',
    attributes?: SpanAttributes,
  ): void {
    recordSpan(name, durationMs, status, attributes);
  }

  /** @see currentTimeline */
  timeline(): readonly SpanRecord[] {
    return currentTimeline();
  }
}

// --- internals ---------------------------------------------------------------------------------

/** Opens a span against a known trace. The only place a span's start time is taken. */
function openSpan(trace: RequestTrace, name: string, attributes?: SpanAttributes): Span {
  const startedAtNs = process.hrtime.bigint();
  const startedAtMs = elapsedMsSince(trace.startedAtNs);
  const spanId = newSpanId();
  let closed = false;

  return {
    name,
    spanId,
    end(status: SpanStatus = 'ok', extra?: SpanAttributes): void {
      // Idempotent. An instrumented component that both returns a value and later rejects would
      // otherwise record two rows for one stage and double-count its time.
      if (closed) return;
      closed = true;

      const merged = { ...attributes, ...extra };
      appendSpan(trace, {
        name,
        startedAtMs,
        durationMs: elapsedMsSince(startedAtNs),
        status,
        spanId,
        ...(Object.keys(merged).length === 0 ? {} : { attributes: merged }),
      });
    },
  };
}

/**
 * How a span ends when `fn` threw.
 *
 * 401, 403 and 429 are the chain refusing, not failing — see {@link traceSpan}. Everything else,
 * including a 500 dressed as an `HttpException`, is an error.
 */
function statusOf(error: unknown): SpanStatus {
  if (!(error instanceof HttpException)) return 'error';
  const status = error.getStatus();
  return status === HttpStatus.UNAUTHORIZED ||
    status === HttpStatus.FORBIDDEN ||
    status === HttpStatus.TOO_MANY_REQUESTS
    ? 'denied'
    : 'error';
}

/** Duck-typed rather than `instanceof Promise`, so a `Bluebird` or a Sequelize thenable counts. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}
