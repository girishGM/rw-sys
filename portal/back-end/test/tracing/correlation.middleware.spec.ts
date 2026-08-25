/**
 * T-019 — `CorrelationMiddleware`, driven directly.
 *
 * TC-1…TC-6 and TC-20 have their decisive form here; `tracing.http.spec.ts` re-proves the same
 * properties over real HTTP through a real Nest chain, because "the middleware decides correctly"
 * and "the decision reaches the response and the log" are two different claims.
 *
 * **TC-4 is the security trap** and gets the most attention: a header containing a newline or a
 * SQL-comment terminator must be refused *and* must not appear anywhere in what the middleware
 * emits. Asserting only the first half would pass a middleware that rejected the value and then
 * helpfully logged what it had rejected.
 */
import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import {
  CorrelationMiddleware,
  REQUEST_ID_HEADER,
  generateCorrelationId,
  generateRequestId,
  levelForStatus,
  outcomeForStatus,
  resolveCorrelationId,
  routeOf,
  type TraceLogWriter,
} from '@/common/tracing/correlation.middleware';
import { CORRELATION_HEADER, CORRELATION_ID_PATTERN } from '@/common/errors/trace-id';
import { TraceContext } from '@/common/tracing/trace-context';
import { traceSpan } from '@/common/tracing/span.service';

const NEWLINE_ATTACK = 'good1234\nts=2026-01-01 level=info msg="admin logged in"';
const SQL_ATTACK = 'good1234*/ OR 1=1 --';

interface Recorded {
  level: string;
  message: string;
  meta: Record<string, unknown>;
}

/** A `TraceLogWriter` that keeps every line, plus the whole thing as one searchable string. */
function recorder(): { writer: TraceLogWriter; lines: Recorded[]; text: () => string } {
  const lines: Recorded[] = [];
  return {
    lines,
    writer: { log: (level, message, meta) => void lines.push({ level, message, meta }) },
    text: () => JSON.stringify(lines),
  };
}

/** A minimal Express request/response pair. `response` is a real emitter so `finish` works. */
function httpPair(
  headers: Record<string, unknown> = {},
  request: Partial<Request> = {},
): { request: Request; response: Response; headersSet: Record<string, unknown> } {
  const headersSet: Record<string, unknown> = {};
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader: (name: string, value: unknown) => void (headersSet[name] = value),
  }) as unknown as Response;

  return {
    headersSet,
    response,
    request: {
      method: 'GET',
      path: '/api/v1/health',
      ip: '10.0.0.4',
      headers,
      ...request,
    } as unknown as Request,
  };
}

describe('resolveCorrelationId', () => {
  it('TC-1 — generates one when the client sends no header', () => {
    const decision = resolveCorrelationId(undefined);

    expect(decision.rejection).toBeNull();
    expect(decision.correlationId).toMatch(CORRELATION_ID_PATTERN);
  });

  it('TC-2 — accepts a well-formed client id unchanged', () => {
    expect(resolveCorrelationId('01J8F3K9QP2M7N')).toEqual({
      correlationId: '01J8F3K9QP2M7N',
      rejection: null,
      rejectedLength: null,
    });
  });

  it.each([
    ['TC-3 — too short', 'abc'],
    ['TC-4 — containing a newline', NEWLINE_ATTACK],
    ['TC-4 — containing a SQL comment terminator', SQL_ATTACK],
    ['TC-5 — 500 characters', 'a'.repeat(500)],
    ['exactly 65 characters (one past the bound)', 'a'.repeat(65)],
    ['exactly 7 characters (one short of the bound)', 'a'.repeat(7)],
    ['containing a space', 'good 1234'],
    ['containing a colon, which would break the SQL comment binding', 'good:1234'],
    ['containing a carriage return', 'good1234\rFAKE'],
    ['empty', ''],
  ])('%s is rejected and replaced', (_label, header) => {
    const decision = resolveCorrelationId(header);

    expect(decision.rejection).toBe('malformed');
    expect(decision.correlationId).not.toBe(header);
    expect(decision.correlationId).toMatch(CORRELATION_ID_PATTERN);
  });

  it('accepts the exact boundary lengths, 8 and 64', () => {
    expect(resolveCorrelationId('a'.repeat(8)).rejection).toBeNull();
    expect(resolveCorrelationId('a'.repeat(64)).rejection).toBeNull();
  });

  it('rejects a duplicated header rather than picking one of the values', () => {
    const decision = resolveCorrelationId(['legit123', 'attacker']);

    expect(decision.rejection).toBe('duplicated');
    expect(decision.rejectedLength).toBeNull();
    expect(decision.correlationId).not.toBe('legit123');
  });

  it('rejects a non-string header value', () => {
    expect(resolveCorrelationId({ toString: () => 'spoofed1' }).rejection).toBe('malformed');
  });
});

describe('generateCorrelationId / generateRequestId', () => {
  it('generates ids that satisfy the pattern the SQL comment relies on', () => {
    for (let i = 0; i < 100; i += 1)
      expect(generateCorrelationId()).toMatch(CORRELATION_ID_PATTERN);
  });

  it('TC-6 — derives the request id from the correlation id but makes it unique', () => {
    const requestIds = new Set(Array.from({ length: 500 }, () => generateRequestId('op123456')));

    expect(requestIds.size).toBe(500);
    for (const id of requestIds) expect(id.startsWith('op123456-')).toBe(true);
  });
});

describe('CorrelationMiddleware', () => {
  it('TC-1 — establishes a context and echoes both ids on the response', () => {
    const log = recorder();
    const { request, response, headersSet } = httpPair();
    let seen: string | null = null;

    new CorrelationMiddleware(log.writer).use(request, response, (() => {
      seen = TraceContext.correlationId();
    }) as NextFunction);

    expect(seen).toMatch(CORRELATION_ID_PATTERN);
    expect(headersSet[CORRELATION_HEADER]).toBe(seen);
    expect(String(headersSet[REQUEST_ID_HEADER])).toContain(String(seen));
  });

  it('TC-2 — uses a valid client id throughout: context, response header, and request seam', () => {
    const log = recorder();
    const { request, response, headersSet } = httpPair({ [CORRELATION_HEADER]: 'client-id-1234' });

    new CorrelationMiddleware(log.writer).use(request, response, (() => undefined) as NextFunction);

    expect(headersSet[CORRELATION_HEADER]).toBe('client-id-1234');
    // The seam `trace-id.ts` left, which is what makes the error envelope's `traceId` match.
    expect((request as Request & { correlationId?: string }).correlationId).toBe('client-id-1234');
  });

  it('continues an upstream trace and records the parent span', () => {
    const log = recorder();
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const { request, response } = httpPair({
      traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
      tracestate: 'rojo=1',
    });
    let trace: ReturnType<typeof TraceContext.current>;

    new CorrelationMiddleware(log.writer).use(request, response, (() => {
      trace = TraceContext.current();
    }) as NextFunction);

    expect(trace?.traceId).toBe(traceId);
    expect(trace?.parentSpanId).toBe('00f067aa0ba902b7');
    expect(trace?.spanId).not.toBe('00f067aa0ba902b7');
    expect(trace?.tracestate).toBe('rojo=1');
  });

  it('starts a new sampled trace when the upstream header is malformed', () => {
    const log = recorder();
    const { request, response } = httpPair({ traceparent: 'not-a-traceparent' });
    let trace: ReturnType<typeof TraceContext.current>;

    new CorrelationMiddleware(log.writer).use(request, response, (() => {
      trace = TraceContext.current();
    }) as NextFunction);

    expect(trace?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(trace?.parentSpanId).toBeNull();
    expect(trace?.sampled).toBe(true);
  });

  describe('TC-3/TC-4/TC-5 — a rejected header warns without reproducing itself', () => {
    it.each([
      ['too short', 'abc'],
      ['a newline injection', NEWLINE_ATTACK],
      ['a SQL comment terminator', SQL_ATTACK],
      ['500 characters', 'a'.repeat(500)],
    ])('warns on %s', (_label, header) => {
      const log = recorder();
      const { request, response } = httpPair({ [CORRELATION_HEADER]: header });

      new CorrelationMiddleware(log.writer).use(
        request,
        response,
        (() => undefined) as NextFunction,
      );

      expect(log.lines).toHaveLength(1);
      expect(log.lines[0].level).toBe('warn');
      expect(log.lines[0].message).toBe('rejected client-supplied correlation id');
    });

    it('TC-4 — the refused bytes appear NOWHERE in what the middleware emits', () => {
      const log = recorder();
      const { request, response, headersSet } = httpPair({
        [CORRELATION_HEADER]: NEWLINE_ATTACK,
      });

      new CorrelationMiddleware(log.writer).use(
        request,
        response,
        (() => undefined) as NextFunction,
      );
      response.statusCode = 200;
      response.emit('finish');

      // Not in any log line, not in the response headers, not in the generated id.
      expect(log.text()).not.toContain('admin logged in');
      expect(log.text()).not.toContain('\\n');
      expect(JSON.stringify(headersSet)).not.toContain('admin logged in');
      expect(String(headersSet[CORRELATION_HEADER])).toMatch(CORRELATION_ID_PATTERN);
    });

    it('TC-4 — a `*/` attempt cannot survive into the id the SQL comment is built from', () => {
      const log = recorder();
      const { request, response, headersSet } = httpPair({ [CORRELATION_HEADER]: SQL_ATTACK });

      new CorrelationMiddleware(log.writer).use(
        request,
        response,
        (() => undefined) as NextFunction,
      );

      expect(String(headersSet[CORRELATION_HEADER])).not.toContain('*/');
      expect(log.text()).not.toContain('*/');
    });

    it('reports the length and the expected pattern, which is all an operator needs', () => {
      const log = recorder();
      const { request, response } = httpPair({ [CORRELATION_HEADER]: 'abc' });

      new CorrelationMiddleware(log.writer).use(
        request,
        response,
        (() => undefined) as NextFunction,
      );

      expect(log.lines[0].meta).toMatchObject({
        correlationHeader: { rejection: 'malformed', length: 3, expected: '^[A-Za-z0-9_-]{8,64}$' },
      });
    });

    it('says nothing at all when the header was valid or absent', () => {
      const log = recorder();
      const { request, response } = httpPair({ [CORRELATION_HEADER]: 'perfectly-fine-id' });

      new CorrelationMiddleware(log.writer).use(
        request,
        response,
        (() => undefined) as NextFunction,
      );

      expect(log.lines).toHaveLength(0);
    });
  });

  describe('the completion line', () => {
    function complete(
      statusCode: number,
      event: 'finish' | 'close' = 'finish',
      requestOverrides: Partial<Request> = {},
    ): Recorded {
      const log = recorder();
      const { request, response } = httpPair({}, requestOverrides);

      new CorrelationMiddleware(log.writer).use(request, response, (() => {
        traceSpan('handler.work', () => undefined);
      }) as NextFunction);

      response.statusCode = statusCode;
      response.emit(event);
      return log.lines[log.lines.length - 1];
    }

    it("carries §3's http, db, outcome and the span timeline", () => {
      const line = complete(200);

      expect(line.message).toBe('request completed');
      expect(line.meta).toMatchObject({
        http: { method: 'GET', route: '/api/v1/health', status: 200, ip: '10.0.0.4' },
        db: { queryCount: 0, totalMs: 0 },
        outcome: { result: 'success' },
      });
      expect((line.meta.spans as { name: string }[]).map((span) => span.name)).toEqual([
        'handler.work',
      ]);
    });

    it('is written inside the trace context, so the envelope can find the ids', () => {
      // The regression guard for the defect `trace-context.spec.ts` documents: a listener
      // registered inside an `AsyncLocalStorage` run does not inherit it.
      const log = recorder();
      const { request, response } = httpPair();
      let observed: string | null = 'not-run';

      const writer: TraceLogWriter = {
        log: (level, message, meta) => {
          observed = TraceContext.correlationId();
          log.writer.log(level, message, meta);
        },
      };

      new CorrelationMiddleware(writer).use(request, response, (() => undefined) as NextFunction);
      response.emit('finish');

      expect(observed).toMatch(CORRELATION_ID_PATTERN);
    });

    it('TC-8 — reports the parameterised route, never the concrete URL', () => {
      const line = complete(200, 'finish', {
        baseUrl: '',
        path: '/api/v1/campaigns/8821/submit',
        route: { path: '/api/v1/campaigns/:id/submit' },
      } as Partial<Request>);

      expect(line.meta.http).toMatchObject({ route: '/api/v1/campaigns/:id/submit' });
      expect(JSON.stringify(line.meta.http)).not.toContain('8821');
    });

    it('records the user agent, and null rather than an empty string when absent', () => {
      const log = recorder();
      const { request, response } = httpPair({ 'user-agent': 'Mozilla/5.0' });
      new CorrelationMiddleware(log.writer).use(
        request,
        response,
        (() => undefined) as NextFunction,
      );
      response.emit('finish');

      expect((log.lines[0].meta.http as { userAgent: string }).userAgent).toBe('Mozilla/5.0');
      expect((complete(200).meta.http as { userAgent: null }).userAgent).toBeNull();
    });

    it.each([
      ['absent', undefined],
      ['an empty string', ''],
      ['an unexpected type', 42],
    ])('reports ip as null when Express supplies %s', (_label, ip) => {
      // `trust proxy` unset on a socket with no remote address, and a non-HTTP-shaped request
      // object, both produce this. `null` keeps the key present and correctly typed; an empty
      // string in an `ip` field is a value a query cannot distinguish from a real one.
      const line = complete(200, 'finish', { ip } as Partial<Request>);

      expect((line.meta.http as { ip: string | null }).ip).toBeNull();
    });

    it('writes exactly one line even when both finish and close fire', () => {
      const log = recorder();
      const { request, response } = httpPair();
      new CorrelationMiddleware(log.writer).use(
        request,
        response,
        (() => undefined) as NextFunction,
      );

      response.emit('finish');
      response.emit('close');
      response.emit('finish');

      expect(log.lines).toHaveLength(1);
    });

    it('reports an aborted request when only close fires', () => {
      const line = complete(200, 'close');

      expect(line.message).toBe('request aborted');
      expect(line.meta.outcome).toEqual({ result: 'aborted' });
    });

    it('carries the parent span id when there was an upstream, and omits the key otherwise', () => {
      const log = recorder();
      const { request, response } = httpPair({
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      });
      new CorrelationMiddleware(log.writer).use(
        request,
        response,
        (() => undefined) as NextFunction,
      );
      response.emit('finish');

      expect(log.lines[0].meta.parentSpanId).toBe('00f067aa0ba902b7');
      expect(complete(200).meta).not.toHaveProperty('parentSpanId');
    });
  });
});

describe('levelForStatus (TC-20) and outcomeForStatus', () => {
  it.each([
    [200, 'info'],
    [201, 'info'],
    [304, 'info'],
    [400, 'info'],
    [404, 'info'],
    [409, 'info'],
    [401, 'warn'],
    [403, 'warn'],
    [429, 'warn'],
    [500, 'error'],
    [503, 'error'],
  ])('logs a %s at %s', (status, level) => {
    expect(levelForStatus(status)).toBe(level);
  });

  it('TC-20 — a permission denial is warn, not info: §4 says so in as many words', () => {
    expect(levelForStatus(403)).toBe('warn');
    expect(levelForStatus(403)).not.toBe('info');
  });

  it.each([
    [200, false, 'success'],
    [302, false, 'success'],
    [403, false, 'rejected'],
    [404, false, 'rejected'],
    [500, false, 'failure'],
    [200, true, 'aborted'],
    [500, true, 'aborted'],
  ])('reports %s (aborted=%s) as %s', (status, aborted, expected) => {
    expect(outcomeForStatus(status, aborted)).toBe(expected);
  });
});

describe('routeOf', () => {
  it('prefixes the router mount path when Express supplies one', () => {
    expect(
      routeOf({ baseUrl: '/api/v1', route: { path: '/me' }, path: '/me' } as unknown as Request),
    ).toBe('/api/v1/me');
  });

  it('tolerates an absent baseUrl', () => {
    expect(routeOf({ route: { path: '/me' }, path: '/me' } as unknown as Request)).toBe('/me');
  });

  it('falls back to the concrete path before the router has matched', () => {
    expect(routeOf({ path: '/api/v1/nope' } as unknown as Request)).toBe('/api/v1/nope');
  });

  it('returns an empty string rather than throwing on a request with neither', () => {
    expect(routeOf({} as unknown as Request)).toBe('');
  });
});
