/**
 * T-019 — chain position 0: the edge where every request acquires its identity.
 *
 * 08-OBSERVABILITY.md §2 draws the whole propagation tree from this one component:
 *
 * ```
 * HTTP in
 *   └─ CorrelationMiddleware          establishes the context
 *       └─ every log line             correlationId, requestId, traceId
 *       └─ every DB query             SQL comment /* cid=… *​/
 *       └─ every audit row            portal_audit_log.correlation_id
 *       └─ every outbound HTTP call   headers propagated
 *       └─ the error response         { "traceId": "…" }
 * ```
 *
 * ---
 *
 * ## The security-critical part: a client-supplied header is validated, never sanitised
 *
 * Implementation note 2, and §1 of the design doc, in the same words:
 *
 * > *"An unvalidated header goes straight into log lines, and a newline in it is log injection —
 * > an attacker forging convincing fake entries."*
 *
 * `X-Correlation-Id` is checked against `^[A-Za-z0-9_-]{8,64}$` **before it is used for
 * anything**. A value that fails is discarded whole and a server id is generated in its place —
 * it is never trimmed, escaped, truncated or partially cleaned, because a partially-cleaned
 * attacker-controlled value is still attacker-controlled. The charset is what simultaneously
 * makes three separate injections impossible: a newline cannot forge a log line, `*​/` cannot
 * close the SQL comment `sql-comment.hook.ts` builds, and no header-delimiter character can
 * split the response header this middleware echoes back.
 *
 * **The rejected value is never logged.** The `warn` that TC-3 requires names the reason and the
 * length; printing the offending bytes to prove they were rejected would put attacker-controlled
 * text into the log line the rejection exists to protect — the exact outcome, one step removed.
 *
 * ## Three ids, three jobs (§1)
 *
 * | Id | Scope | This file's role |
 * |---|---|---|
 * | `correlationId` | one business operation, across services and retries | accept if well-formed, else generate |
 * | `requestId` | this HTTP request | **always** server-generated, so two retries differ (TC-6) |
 * | `traceId`/`spanId` | W3C `traceparent` | continue the upstream trace, or start one |
 *
 * ## Why the completion line is written from `res.on('finish')`
 *
 * An interceptor would have been the more idiomatic Nest choice and is the wrong one here. An
 * interceptor never runs for a request a **guard** rejected — `RouterProxy` hands a guard's
 * exception straight to the exception layer — and never runs for a 404 that matched no route at
 * all. Those are precisely the requests an investigation is about. A `finish` listener sees every
 * response the process writes, with the status it actually sent and the duration it actually
 * took, and it is registered inside the `AsyncLocalStorage` run so it still has the trace.
 */
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedRequest } from '@/modules/auth/decorators/current-user.decorator';
import { CORRELATION_HEADER, isValidCorrelationId } from '@/common/errors/trace-id';
import type { PortalLogLevel } from './logger.config';
import {
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  newSpanId,
  newTraceId,
  parseTraceparent,
  sanitiseTracestate,
} from './otel';
import {
  ANONYMOUS_ACTOR,
  TraceContext,
  UNSCOPED,
  elapsedMsSince,
  type RequestSnapshot,
  type RequestTrace,
  type TraceActor,
  type TraceScope,
} from './trace-context';

/** The header carrying the server-generated per-request id (§1). Always set on the response. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * The minimal logging surface this middleware needs.
 *
 * A narrow interface rather than `winston.Logger` so the middleware can be unit-tested against a
 * two-line double, and so nothing here depends on which library `LoggerModule` chose. `TracingModule`
 * binds it to the real winston instance.
 */
export interface TraceLogWriter {
  log(level: PortalLogLevel, message: string, meta: Record<string, unknown>): void;
}

/** DI token for {@link TraceLogWriter}. */
export const TRACE_LOG_WRITER = Symbol('TRACE_LOG_WRITER');

/** Why a client-supplied correlation id was refused. Reported; the value itself never is. */
export type CorrelationRejection = 'malformed' | 'duplicated';

/** What {@link resolveCorrelationId} decided, and why. */
export interface CorrelationDecision {
  readonly correlationId: string;
  /** `null` when the client's own id was accepted, or when it sent none. */
  readonly rejection: CorrelationRejection | null;
  /** Length of the refused value, for the `warn`. Never the value. */
  readonly rejectedLength: number | null;
}

/**
 * Decides the correlation id for one request.
 *
 * Exported and pure so that TC-2…TC-5 can be asserted directly on the decision rather than
 * inferred from a log line — this is the function the whole security argument above rests on.
 */
export function resolveCorrelationId(header: unknown): CorrelationDecision {
  if (header === undefined) {
    return { correlationId: generateCorrelationId(), rejection: null, rejectedLength: null };
  }

  if (isValidCorrelationId(header)) {
    return { correlationId: header, rejection: null, rejectedLength: null };
  }

  // Node yields an array when a header arrives more than once. No legitimate client does that,
  // and picking one of the values would let an attacker choose which id an operator searches by.
  const duplicated = Array.isArray(header);
  return {
    correlationId: generateCorrelationId(),
    rejection: duplicated ? 'duplicated' : 'malformed',
    rejectedLength: typeof header === 'string' ? header.length : null,
  };
}

/**
 * A server-generated correlation id.
 *
 * `randomUUID()` rather than a ULID or a counter: it satisfies `^[A-Za-z0-9_-]{8,64}$` as it
 * stands (hex and hyphens), it is what `trace-id.ts` already generates for the same purpose, and
 * introducing a second id format for the same field would mean an operator has to recognise two.
 */
export function generateCorrelationId(): string {
  return randomUUID();
}

/**
 * The per-request id: the correlation id, plus a random suffix.
 *
 * Derived from the correlation id rather than independent, so that a human reading a log line can
 * see at a glance which operation a request belongs to (§1's example is `01J8F3K9QP2M7N-a1`).
 * Four random bytes rather than the example's two hex characters, because a client may legally
 * reuse one correlation id across many requests and a 1-in-256 collision inside one operation
 * would break exactly the "distinguish the retries" property the id exists for.
 */
export function generateRequestId(correlationId: string): string {
  return `${correlationId}-${randomBytes(4).toString('hex')}`;
}

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  constructor(@Inject(TRACE_LOG_WRITER) private readonly logger: TraceLogWriter) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const decision = resolveCorrelationId(request.headers[CORRELATION_HEADER]);
    const requestId = generateRequestId(decision.correlationId);
    const parent = parseTraceparent(request.headers[TRACEPARENT_HEADER]);

    const trace: RequestTrace = {
      correlationId: decision.correlationId,
      requestId,
      traceId: parent?.traceId ?? newTraceId(),
      spanId: newSpanId(),
      parentSpanId: parent?.spanId ?? null,
      // An upstream that made a sampling decision owns it; a trace that starts here is sampled,
      // because 08-OBSERVABILITY.md §7's sampling is a T-052 cost control and the safe default
      // until it exists is to keep everything.
      sampled: parent?.sampled ?? true,
      tracestate: sanitiseTracestate(request.headers[TRACESTATE_HEADER]),
      method: request.method,
      startedAt: new Date(),
      startedAtNs: process.hrtime.bigint(),
      snapshot: () => snapshotOf(request),
      spans: [],
      db: { queryCount: 0, totalMs: 0 },
    };

    // The seam `trace-id.ts` left for this task: `resolveTraceId()` checks `request.correlationId`
    // first and wins, so the error envelope's `traceId`, T-018's AAD binding and this middleware
    // all name the same value with no further coordination (TC-15).
    (request as AuthenticatedRequest & { correlationId?: string }).correlationId =
      decision.correlationId;

    response.setHeader(CORRELATION_HEADER, decision.correlationId);
    response.setHeader(REQUEST_ID_HEADER, requestId);

    TraceContext.run(trace, () => {
      if (decision.rejection !== null) this.warnRejectedHeader(decision);

      let completed = false;
      const complete = (aborted: boolean): void => {
        if (completed) return;
        completed = true;
        // **Re-entering the store is not redundant.** A listener registered inside an
        // `AsyncLocalStorage` run does *not* inherit that run: `AsyncLocalStorage` follows the
        // async-resource chain, and an `EventEmitter` callback executes in the context of
        // whatever called `emit()` — here, Node's socket machinery flushing the response, which
        // is a different chain entirely. Without this the completion line would be the one line
        // per request with **no** correlation id, actor or scope, which is precisely the line
        // TC-23 asks an engineer to find. `trace-context.spec.ts` pins the underlying Node
        // behaviour so this comment cannot rot into a false explanation.
        TraceContext.run(trace, () => this.writeCompletionLine(trace, response, aborted));
      };

      response.on('finish', () => complete(false));
      // A client that disconnects mid-response never fires `finish`. Without this the request
      // would leave no line at all, which is a hole in exactly the story TC-23 asks to be able to
      // reconstruct.
      response.on('close', () => complete(true));

      next();
    });
  }

  /**
   * TC-3/TC-4/TC-5. Reports the refusal without reproducing the refused bytes — see the header.
   */
  private warnRejectedHeader(decision: CorrelationDecision): void {
    this.logger.log('warn', 'rejected client-supplied correlation id', {
      outcome: { result: 'rejected', reason: decision.rejection },
      correlationHeader: {
        rejection: decision.rejection,
        length: decision.rejectedLength,
        expected: '^[A-Za-z0-9_-]{8,64}$',
      },
    });
  }

  /**
   * §3's "request completed" line: the one line per request that carries the whole envelope.
   *
   * The spans travel on it. 08-OBSERVABILITY.md §5's waterfall needs somewhere to live, and in
   * Wave 1 there is no trace store to put it in — T-045 builds the retrieval endpoint and T-052
   * the OTel exporter. Emitting the timeline here means the acceptance question ("given one
   * `correlationId`, can an engineer reconstruct the complete story?") is answerable **today**,
   * from a log query and nothing else. It is bounded by `MAX_SPANS_PER_REQUEST`.
   */
  private writeCompletionLine(trace: RequestTrace, response: Response, aborted: boolean): void {
    const snapshot = trace.snapshot();
    const durationMs = elapsedMsSince(trace.startedAtNs);
    const status = response.statusCode;

    this.logger.log(levelForStatus(status), aborted ? 'request aborted' : 'request completed', {
      http: {
        method: trace.method,
        route: snapshot.route,
        status,
        durationMs,
        ip: snapshot.ip,
        userAgent: snapshot.userAgent,
      },
      db: { queryCount: trace.db.queryCount, totalMs: trace.db.totalMs },
      outcome: { result: outcomeForStatus(status, aborted) },
      spans: trace.spans,
      ...(trace.parentSpanId === null ? {} : { parentSpanId: trace.parentSpanId }),
    });
  }
}

// --- module-private helpers --------------------------------------------------------------------

/**
 * 08-OBSERVABILITY.md §4's level table, applied to a completed request.
 *
 * A 5xx is `error`. **401, 403 and 429 are `warn`** — implementation note 9 and §4 are explicit
 * that *"a permission denial is `warn`, not `info`: one is noise, a hundred a minute from one
 * account is an attack, and it must surface at a level people alert on"* (TC-20). Everything
 * else, including a 404 and a 400, is `info`: §4 puts "request completed" there.
 */
export function levelForStatus(status: number): PortalLogLevel {
  if (status >= 500) return 'error';
  if (status === 401 || status === 403 || status === 429) return 'warn';
  return 'info';
}

/** §3's `outcome.result`. Three values, so a query can separate "refused" from "broke". */
export function outcomeForStatus(status: number, aborted: boolean): string {
  if (aborted) return 'aborted';
  if (status >= 500) return 'failure';
  if (status >= 400) return 'rejected';
  return 'success';
}

/**
 * Route, actor, scope, IP and user agent, resolved from the request at the moment of the call.
 *
 * `actor` and `scope` are read from `request.authUser`, which `JwtAuthGuard` is the only writer
 * of — AGENT-PROTOCOL R3's "from the verified JWT only" holds because there is no other path into
 * this function. A DTO field named `tenantId` cannot reach it.
 */
function snapshotOf(request: Request): RequestSnapshot {
  const authenticated = request as AuthenticatedRequest;
  return {
    route: routeOf(request),
    actor: actorOf(authenticated),
    scope: scopeOf(authenticated),
    ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
    userAgent: headerString(request.headers['user-agent']),
  };
}

function actorOf(request: AuthenticatedRequest): TraceActor {
  const user = request.authUser;
  if (user === undefined) return ANONYMOUS_ACTOR;
  return { userId: user.userId, role: user.role, sessionId: user.sessionId };
}

function scopeOf(request: AuthenticatedRequest): TraceScope {
  const user = request.authUser;
  if (user === undefined) return UNSCOPED;
  return { countryId: user.countryId, tenantId: user.tenantId, merchantId: user.merchantId };
}

/**
 * The **parameterised** route (TC-8), prefixed by whatever the router was mounted at.
 *
 * §3: *"`/campaigns/8821/submit` fragments aggregation into thousands of buckets **and can itself
 * carry identifiers**."* Express only fills `request.route` once a handler has matched, so a 404
 * and anything rejected before routing fall back to the concrete path — the same fallback
 * `error-normalization.filter.ts` and `audit.service.ts` already use, kept identical so the three
 * records of one request name the same route.
 */
export function routeOf(request: Request): string {
  const route = (request as { route?: { path?: unknown } }).route;
  if (typeof route?.path === 'string') return `${request.baseUrl ?? ''}${route.path}`;
  return typeof request.path === 'string' ? request.path : '';
}

/** A header value as a string, or `null` — never an array, never an empty string. */
function headerString(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}
