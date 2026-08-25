/**
 * T-019 — the per-request trace, and the `AsyncLocalStorage` that carries it.
 *
 * 08-OBSERVABILITY.md §2 states the rule this file makes mechanical:
 *
 * > *"`AsyncLocalStorage` carries the trace context for the request's whole lifetime, so no
 * > function needs to thread it through its signature — and therefore nobody forgets."*
 *
 * The shape is deliberately the same as `scope-context.ts` (T-013) and `audit-context.ts`
 * (T-014): a module-private `AsyncLocalStorage`, a frozen-ish store, and a namespace of
 * functions rather than an injectable service — because `AsyncLocalStorage` is process-global by
 * nature and injecting it would imply, falsely, that two instances could coexist and mean
 * different things.
 *
 * ---
 *
 * ## Why `actor` and `scope` are functions and not fields
 *
 * 08-OBSERVABILITY.md §3 requires `actor` and `scope` on **every** log line, and AGENT-PROTOCOL
 * R3 requires both to come from the verified JWT and nothing else. Those two requirements pull
 * in opposite directions with a plain field: the correlation middleware runs at chain position 0,
 * *before* `JwtAuthGuard` (position 5) has verified anything, so at the moment the store is
 * created there is no actor to put in it. The obvious fix — let the guard write back into the
 * store — creates a mutable, request-lifetime object that two concurrent requests could in
 * principle be handed the wrong copy of, which is exactly the bleed TC-12 exists to catch.
 *
 * So the store holds a **closure over the request object** instead. Every read resolves
 * `request.authUser` — the single field `JwtAuthGuard` is the only writer of — at the moment the
 * line is written. An unauthenticated request yields all-`null` fields rather than missing keys
 * (TC-10), a request that authenticates halfway through yields `null` before and the real actor
 * after, and there is no writable actor state anywhere for a concurrent request to reach.
 *
 * ## Why the span list is mutable when everything else is not
 *
 * A trace exists to accumulate spans; freezing the list would defeat it. It is bounded instead
 * ({@link MAX_SPANS_PER_REQUEST}), because a handler with a loop in it must not be able to turn
 * one request into unbounded memory — the cost of losing the tail of a pathological timeline is
 * far lower than the cost of an out-of-memory kill, and the truncation is visible in the emitted
 * timeline rather than silent.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Who made the request, as far as the verified JWT is concerned. Every field nullable (TC-10). */
export interface TraceActor {
  readonly userId: number | null;
  readonly role: string | null;
  readonly sessionId: string | null;
}

/** The tenancy scope of the request, from the same verified JWT (00-ARCHITECTURE.md §5.1). */
export interface TraceScope {
  readonly countryId: number | null;
  readonly tenantId: number | null;
  readonly merchantId: number | null;
}

/** What a log line needs about the request itself, resolved at the moment it is written. */
export interface RequestSnapshot {
  /** The **parameterised** route (`/api/v1/campaigns/:id/submit`), never the concrete URL. */
  readonly route: string;
  readonly actor: TraceActor;
  readonly scope: TraceScope;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** How a span ended. `denied` is distinct from `error`: a guard refusing is not a fault. */
export type SpanStatus = 'ok' | 'error' | 'denied';

/** One row of the §5 waterfall. */
export interface SpanRecord {
  /** Dotted and stable — `jwt.verify`, `db.select`, `campaigns.submit`. Aggregation depends on it. */
  readonly name: string;
  /** Milliseconds since the request's own start, so the timeline renders without a base. */
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly status: SpanStatus;
  /** W3C span id, so a span in this process can be the parent of one in another. */
  readonly spanId: string;
  /** Free-form, small, and **never** a payload — it is written to logs like everything else. */
  readonly attributes?: Readonly<Record<string, string | number | boolean | null>>;
}

/** `db.queryCount` / `db.totalMs` of the §3 envelope. The only mutable counters in the store. */
export interface DbCounters {
  queryCount: number;
  totalMs: number;
}

/**
 * Everything known about one in-flight request.
 *
 * `correlationId`, `requestId`, `traceId` and `spanId` are fixed at the edge and never change —
 * a trace whose identifiers could be reassigned mid-request is not a trace.
 */
export interface RequestTrace {
  /** One logical business operation, across services and retries. What an operator searches by. */
  readonly correlationId: string;
  /** This HTTP request. Differs between two retries of the same operation (TC-6). */
  readonly requestId: string;
  /** W3C trace id — inherited from an upstream `traceparent` when there was a valid one. */
  readonly traceId: string;
  /** W3C span id of the request span itself. Parent of every span recorded during the request. */
  readonly spanId: string;
  /** The upstream span this request continues, or `null` when the trace starts here. */
  readonly parentSpanId: string | null;
  readonly sampled: boolean;
  /** Upstream `tracestate`, already validated, forwarded verbatim on outbound calls. */
  readonly tracestate: string | null;
  readonly method: string;
  /** Wall-clock start, for the `ts` of the completion line. */
  readonly startedAt: Date;
  /** Monotonic start, for durations. `Date` is not monotonic and can go backwards under NTP. */
  readonly startedAtNs: bigint;
  /** Resolves route/actor/scope from the request, at the moment of the call. See the header. */
  readonly snapshot: () => RequestSnapshot;
  /** The §5 waterfall, in completion order. Bounded — see {@link MAX_SPANS_PER_REQUEST}. */
  readonly spans: SpanRecord[];
  readonly db: DbCounters;
}

/**
 * The most spans one request may accumulate.
 *
 * 200 is far beyond any request this application makes (the deepest measured chain in §5 is 14)
 * and is a bound on memory per request, not a feature. Beyond it, spans are dropped and the
 * timeline reports the drop rather than silently lying about how many there were.
 */
export const MAX_SPANS_PER_REQUEST = 200;

/** An actor with every field null — an unauthenticated request. Shared, frozen, never mutated. */
export const ANONYMOUS_ACTOR: TraceActor = Object.freeze({
  userId: null,
  role: null,
  sessionId: null,
});

/** A scope with every field null. Same rationale as {@link ANONYMOUS_ACTOR}. */
export const UNSCOPED: TraceScope = Object.freeze({
  countryId: null,
  tenantId: null,
  merchantId: null,
});

const storage = new AsyncLocalStorage<RequestTrace>();

/**
 * The trace context.
 *
 * Nothing here throws. Unlike `ScopeContext.require` — where a missing context means an unscoped
 * query and must be a hard failure — a missing *trace* context means a log line without a
 * correlation id, and turning that into a 500 would let an observability gap take the portal
 * down. Every accessor degrades to `undefined`/`null` outside a request.
 */
export const TraceContext = {
  /** Runs `fn` with `trace` established. Everything it awaits or schedules inherits it. */
  run<T>(trace: RequestTrace, fn: () => T): T {
    return storage.run(trace, fn);
  },

  /** The current trace, or `undefined` outside a request (a CLI, a boot-time log line). */
  current(): RequestTrace | undefined {
    return storage.getStore();
  },

  /** The current correlation id, or `null`. The one accessor most callers want. */
  correlationId(): string | null {
    return storage.getStore()?.correlationId ?? null;
  },

  /** Whether a trace is established. For diagnostics and for the no-op paths of instrumentation. */
  isActive(): boolean {
    return storage.getStore() !== undefined;
  },
} as const;

/**
 * Appends a span to a trace, honouring {@link MAX_SPANS_PER_REQUEST}.
 *
 * Exported rather than inlined into `SpanService` so that the bound is enforced in exactly one
 * place — an instrumentation point that appended directly would be an unbounded one.
 */
export function appendSpan(trace: RequestTrace, span: SpanRecord): void {
  if (trace.spans.length >= MAX_SPANS_PER_REQUEST) return;
  trace.spans.push(span);
}

/** Milliseconds elapsed since `startedAtNs`, to three decimal places. Monotonic, never negative. */
export function elapsedMsSince(startedAtNs: bigint): number {
  const deltaNs = process.hrtime.bigint() - startedAtNs;
  return Math.round(Number(deltaNs) / 1e3) / 1e3;
}
