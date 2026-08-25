/**
 * T-014 — the `traceId` every error response carries.
 *
 * 08-OBSERVABILITY.md §2 is explicit about what it is:
 *
 * > *"The error-response `traceId` **is** the `correlation_id`, deliberately. A user reporting
 * > 'it said error b7f3…' hands you the exact search key. It reveals nothing sensitive."*
 *
 * ### Why this file exists at all, given T-019 owns tracing
 *
 * T-019 builds the real correlation layer — `AsyncLocalStorage`, the `X-Request-Id`, W3C
 * `traceparent`, the SQL comment — and it depends on T-014. So this task ships the *minimum* the
 * error envelope requires and leaves a seam of exactly one function for T-019 to take over:
 * everything else reads `resolveTraceId(request)` and does not care where the value came from.
 *
 * **T-019: `request.correlationId` is checked first and wins.** Populate it from your middleware
 * and this function becomes a pass-through; nothing else in the error path needs to change.
 *
 * ### Why the client-supplied header is validated before it is used
 *
 * 08-OBSERVABILITY.md §1: *"An unvalidated header goes straight into log lines, and a newline in
 * it is log injection — an attacker forging convincing fake log entries."* The pattern below is
 * the one that document specifies, character for character. Anything that fails it is discarded
 * silently and a server-generated id is used instead — never sanitised-and-kept, because a
 * partially-cleaned attacker-controlled value is still attacker-controlled.
 *
 * ### Why it is memoised on the request
 *
 * TC-16: *"`traceId` in the response matches the `traceId` in the server log for that request."*
 * That only holds if both reads produce the same value, so the id is computed once and cached
 * under a module-private `Symbol` — a symbol rather than a string key so that nothing else,
 * including a request body parsed into `request`, can collide with or forge it (the same
 * technique, for the same reason, as `request-identity.ts`).
 */
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';

/** 08-OBSERVABILITY.md §1, verbatim. Alphanumerics, `_` and `-` only — no newline, no space. */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** The header a client may set to join its own operation id to ours (08-OBSERVABILITY.md §1). */
export const CORRELATION_HEADER = 'x-correlation-id';

/** Where the resolved id is cached for the life of the request. */
const TRACE_ID_CACHE = Symbol('rs.traceId');

/** A request that may already carry a correlation id — either T-019's, or this file's cache. */
interface TraceableRequest extends Request {
  correlationId?: unknown;
  [TRACE_ID_CACHE]?: string;
}

/** Whether a candidate is a well-formed correlation id. Exported for T-019 and for tests. */
export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && CORRELATION_ID_PATTERN.test(value);
}

/**
 * The trace id for this request: T-019's correlation id if present, else a validated client
 * header, else a fresh server-generated one. Stable for the request's lifetime.
 *
 * Never throws and never returns an empty string — an error response with no trace id is an
 * error report nobody can act on.
 */
export function resolveTraceId(request: Request | undefined): string {
  if (request === undefined) return randomUUID();

  const traceable = request as TraceableRequest;
  const cached = traceable[TRACE_ID_CACHE];
  if (cached !== undefined) return cached;

  const resolved = resolve(traceable);
  traceable[TRACE_ID_CACHE] = resolved;
  return resolved;
}

function resolve(request: TraceableRequest): string {
  // T-019's middleware, once it exists.
  if (isValidCorrelationId(request.correlationId)) return request.correlationId;

  // A client-supplied header, only if it is well-formed. Express lower-cases header names and
  // yields `string | string[] | undefined`; an array means the header was sent twice, which a
  // legitimate client does not do — `isValidCorrelationId` rejects it.
  const header = request.headers?.[CORRELATION_HEADER];
  if (isValidCorrelationId(header)) return header;

  return randomUUID();
}
