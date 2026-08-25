/**
 * T-045 — the trace wire contract, tested in the package that declares it. Same rationale as
 * `bootstrap.schema.spec.ts`: `back-end/test/trace/trace.contract.spec.ts` parses a real response
 * through this schema, and this suite exists for the front end, which has no access to that
 * suite, plus every rejection case that proves `.strict()` is doing its job.
 */
import {
  TRACE_CORRELATION_ID_PATTERN,
  traceEnvelopeSchema,
  traceResponseSchema,
  traceSourcesSchema,
  traceSpanSchema,
} from './trace.schema';

const sources = {
  portalAuditLog: 'available' as const,
  domainAudit: 'available' as const,
  logStore: 'available' as const,
  configFetches: 'not_configured' as const,
};

const validResponse = {
  correlationId: '01J8F3K9QP2M7N',
  summary: {
    correlationId: '01J8F3K9QP2M7N',
    startedAt: '2026-08-14T09:12:33.481Z',
    durationMs: 142,
    actor: { userId: 42, role: 'maker', sessionId: 'abc' },
    scope: { countryId: 3, tenantId: 7, merchantId: null },
    route: 'POST /api/v1/campaigns/:id/submit',
    status: 200,
  },
  spans: [
    {
      name: 'jwt.verify',
      startedAtMs: 0.2,
      durationMs: 0.8,
      status: 'ok' as const,
      spanId: 'abc123',
      slow: false,
      attributes: null,
    },
  ],
  sources,
  auditEvents: [],
  domainAudit: [],
  configFetches: [],
  logLines: [{ ts: '2026-08-14T09:12:33.481Z', msg: 'request completed' }],
  truncated: false,
};

describe('TRACE_CORRELATION_ID_PATTERN', () => {
  it('matches the back end pattern, character for character (08-OBSERVABILITY.md §1)', () => {
    expect(TRACE_CORRELATION_ID_PATTERN.source).toBe('^[A-Za-z0-9_-]{8,64}$');
  });

  it('accepts a well-formed id and rejects the shapes that must never reach a query', () => {
    expect(TRACE_CORRELATION_ID_PATTERN.test('01J8F3K9QP2M7N')).toBe(true);
    expect(TRACE_CORRELATION_ID_PATTERN.test('short')).toBe(false);
    expect(TRACE_CORRELATION_ID_PATTERN.test('has a space')).toBe(false);
    expect(TRACE_CORRELATION_ID_PATTERN.test('../../etc/passwd')).toBe(false);
    expect(TRACE_CORRELATION_ID_PATTERN.test('has\nnewline12')).toBe(false);
  });
});

describe('traceSourcesSchema', () => {
  it('accepts the three declared statuses', () => {
    expect(traceSourcesSchema.safeParse(sources).success).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(traceSourcesSchema.safeParse({ ...sources, logStore: 'flaky' }).success).toBe(false);
  });

  it('rejects a missing source', () => {
    const rest: Record<string, unknown> = { ...sources };
    delete rest.configFetches;
    expect(traceSourcesSchema.safeParse(rest).success).toBe(false);
  });
});

describe('traceSpanSchema', () => {
  it('accepts a well-formed span', () => {
    expect(traceSpanSchema.safeParse(validResponse.spans[0]).success).toBe(true);
  });

  it('rejects an unknown span status', () => {
    expect(
      traceSpanSchema.safeParse({ ...validResponse.spans[0], status: 'timeout' }).success,
    ).toBe(false);
  });

  it('rejects an extra key (strict)', () => {
    expect(traceSpanSchema.safeParse({ ...validResponse.spans[0], extra: true }).success).toBe(
      false,
    );
  });
});

describe('traceResponseSchema', () => {
  it('accepts a fully-populated response', () => {
    const parsed = traceResponseSchema.safeParse(validResponse);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  it('accepts the degraded shape — logLines: null (TC-5)', () => {
    const degraded = {
      ...validResponse,
      sources: { ...sources, logStore: 'unavailable' as const },
      logLines: null,
    };
    expect(traceResponseSchema.safeParse(degraded).success).toBe(true);
  });

  it('accepts the empty-domain-audit shape (TC-19)', () => {
    expect(traceResponseSchema.safeParse({ ...validResponse, domainAudit: [] }).success).toBe(true);
  });

  it('accepts a summary with every field null (no completion line found)', () => {
    const noSummary = {
      ...validResponse,
      summary: {
        correlationId: validResponse.correlationId,
        startedAt: null,
        durationMs: null,
        actor: null,
        scope: null,
        route: null,
        status: null,
      },
    };
    expect(traceResponseSchema.safeParse(noSummary).success).toBe(true);
  });

  it('rejects a response with the logLines key missing entirely', () => {
    const rest: Record<string, unknown> = { ...validResponse };
    delete rest.logLines;
    expect(traceResponseSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an unrecognised top-level key', () => {
    expect(traceResponseSchema.safeParse({ ...validResponse, unexpected: 1 }).success).toBe(false);
  });
});

describe('traceEnvelopeSchema', () => {
  it('wraps the response in the { data } envelope (03-API-CONTRACT.md §1)', () => {
    expect(traceEnvelopeSchema.safeParse({ data: validResponse }).success).toBe(true);
  });
});
