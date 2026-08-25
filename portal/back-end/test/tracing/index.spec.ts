/**
 * T-019 — the barrel's public surface.
 *
 * Two things are asserted, both of which are about *other* tasks rather than this one:
 *
 *  1. **The names Wave 3 and T-045 will import actually exist**, so a rename here breaks a test
 *     in this task rather than a build in somebody else's.
 *  2. **Importing `@/common/tracing` does not reach a `process.exit`.** `ConfigModule`'s
 *     `validate` calls `process.exit(1)` on an incomplete environment at import time, so a barrel
 *     that transitively pulled in `TracingModule` → `DatabaseModule` → `ConfigModule` would kill
 *     any Jest worker that touched it — the exact hazard `@/common/crypto`, `@/common/rbac`,
 *     `@/common/audit` and `@/common/data-protection` each document. The fact that this file
 *     imports the barrel and runs at all is the assertion; the explicit check below just makes
 *     the intent legible.
 */
import * as tracing from '@/common/tracing';

describe('@/common/tracing', () => {
  it('exports the names other tasks depend on', () => {
    // The instrumentation entry points (one line, no constructor change — six tasks use these).
    expect(typeof tracing.traceSpan).toBe('function');
    expect(typeof tracing.startSpan).toBe('function');
    expect(typeof tracing.recordSpan).toBe('function');
    expect(typeof tracing.currentTimeline).toBe('function');
    expect(typeof tracing.SpanService).toBe('function');
    expect(tracing.CHAIN_SPAN.JWT_VERIFY).toBe('jwt.verify');

    // The ambient context (T-045 reads timelines; Wave 3 reads the correlation id).
    expect(typeof tracing.TraceContext.correlationId).toBe('function');
    expect(typeof tracing.TraceContext.current).toBe('function');
    expect(typeof tracing.TraceContext.run).toBe('function');
    expect(typeof tracing.TraceContext.isActive).toBe('function');
    expect(tracing.MAX_SPANS_PER_REQUEST).toBe(200);

    // Propagation to another service (TC-22) and the wire format.
    expect(typeof tracing.outboundTraceHeaders).toBe('function');
    expect(typeof tracing.parseTraceparent).toBe('function');
    expect(typeof tracing.formatTraceparent).toBe('function');
    expect(tracing.TRACEPARENT_HEADER).toBe('traceparent');

    // The edge, and the SQL comment.
    expect(typeof tracing.CorrelationMiddleware).toBe('function');
    expect(typeof tracing.resolveCorrelationId).toBe('function');
    expect(typeof tracing.installSqlCommentHook).toBe('function');
    expect(typeof tracing.sqlComment).toBe('function');
  });

  it('does not re-export TracingModule or the logger config', () => {
    // Deliberate: both reach `ConfigModule`/winston. See the barrel's own header.
    expect(tracing).not.toHaveProperty('TracingModule');
    expect(tracing).not.toHaveProperty('buildLoggerOptions');
    expect(tracing).not.toHaveProperty('logPolicyBinding');
  });
});
