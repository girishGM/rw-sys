/**
 * T-019 — shared fixtures for the tracing suites.
 *
 * One place that knows how to build a `RequestTrace`, so that adding a field to the interface
 * breaks compilation here rather than silently leaving twenty specs asserting against a shape the
 * production code no longer has.
 */
import {
  ANONYMOUS_ACTOR,
  UNSCOPED,
  type RequestSnapshot,
  type RequestTrace,
} from '@/common/tracing/trace-context';

/** Everything a spec might want to vary, all optional. */
export interface TraceOverrides {
  correlationId?: string;
  requestId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string | null;
  sampled?: boolean;
  tracestate?: string | null;
  method?: string;
  snapshot?: () => RequestSnapshot;
}

/** A `RequestTrace` with sensible defaults and a fresh span list per call. */
export function makeTrace(overrides: TraceOverrides = {}): RequestTrace {
  return {
    correlationId: overrides.correlationId ?? 'test-correlation-id',
    requestId: overrides.requestId ?? 'test-correlation-id-aabbccdd',
    traceId: overrides.traceId ?? '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: overrides.spanId ?? '00f067aa0ba902b7',
    parentSpanId: overrides.parentSpanId ?? null,
    sampled: overrides.sampled ?? true,
    tracestate: overrides.tracestate ?? null,
    method: overrides.method ?? 'GET',
    startedAt: new Date('2026-08-18T09:12:33.481Z'),
    startedAtNs: process.hrtime.bigint(),
    snapshot: overrides.snapshot ?? (() => anonymousSnapshot()),
    spans: [],
    db: { queryCount: 0, totalMs: 0 },
  };
}

/** The snapshot an unauthenticated request produces (TC-10). */
export function anonymousSnapshot(route = '/api/v1/health'): RequestSnapshot {
  return { route, actor: ANONYMOUS_ACTOR, scope: UNSCOPED, ip: null, userAgent: null };
}

/** The snapshot an authenticated request produces (TC-9). */
export function authenticatedSnapshot(route = '/api/v1/campaigns/:id/submit'): RequestSnapshot {
  return {
    route,
    actor: { userId: 42, role: 'maker', sessionId: 'sess-1' },
    scope: { countryId: 3, tenantId: 7, merchantId: null },
    ip: '10.0.0.4',
    userAgent: 'Mozilla/5.0',
  };
}
