/**
 * T-019 — `traceSpan` and `SpanService`.
 *
 * `traceSpan` is called from nine finished components across six completed tasks
 * (`CsrfGuard`, `JwtAuthGuard`, `SessionValidGuard`, `PermissionsGuard`,
 * `TenancyScopeInterceptor`, `PayloadDecryptInterceptor`, `AuditInterceptor`,
 * `ResponseMaskingInterceptor`, `PayloadEncryptInterceptor`), which makes the **transparency**
 * property the most important thing in this file: with no trace established it must be exactly
 * `fn()` — same value, same exception, same synchronous/asynchronous shape, no allocation. If
 * that ever stops being true, six tasks' worth of security decisions change behaviour at once.
 */
import {
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  CHAIN_SPAN,
  DB_SPAN_PREFIX,
  SpanService,
  currentTimeline,
  recordSpan,
  startSpan,
  traceSpan,
} from '@/common/tracing/span.service';
import { MAX_SPANS_PER_REQUEST, TraceContext } from '@/common/tracing/trace-context';
import { makeTrace } from './support/trace-fixtures';

describe('traceSpan — transparency with no trace established', () => {
  it('returns the value unchanged and records nothing', () => {
    expect(traceSpan('x', () => 'value')).toBe('value');
    expect(currentTimeline()).toEqual([]);
  });

  it('propagates a thrown error unchanged', () => {
    const boom = new Error('boom');
    expect(() =>
      traceSpan('x', () => {
        throw boom;
      }),
    ).toThrow(boom);
  });

  it('returns the very same promise object, not a wrapper', async () => {
    const promise = Promise.resolve(1);
    expect(traceSpan('x', () => promise)).toBe(promise);
    await promise;
  });

  it('propagates a rejection unchanged', async () => {
    await expect(traceSpan('x', () => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
  });
});

describe('traceSpan — inside a trace', () => {
  it('records a span with a name, a duration and an ok status', () => {
    const trace = makeTrace();

    const result = TraceContext.run(trace, () => traceSpan(CHAIN_SPAN.JWT_VERIFY, () => 'ok'));

    expect(result).toBe('ok');
    expect(trace.spans).toHaveLength(1);
    expect(trace.spans[0].name).toBe('jwt.verify');
    expect(trace.spans[0].status).toBe('ok');
    expect(trace.spans[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(trace.spans[0].spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('times an async function properly rather than reporting the construction cost', async () => {
    const trace = makeTrace();

    await TraceContext.run(trace, () =>
      traceSpan('slow.work', async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }),
    );

    expect(trace.spans[0].durationMs).toBeGreaterThanOrEqual(20);
  });

  it('records the span and rethrows when the function throws', () => {
    const trace = makeTrace();

    expect(() =>
      TraceContext.run(trace, () =>
        traceSpan('failing', () => {
          throw new Error('inner');
        }),
      ),
    ).toThrow('inner');

    expect(trace.spans[0]).toMatchObject({ name: 'failing', status: 'error' });
  });

  it('records the span and rethrows when a promise rejects', async () => {
    const trace = makeTrace();

    await expect(
      TraceContext.run(trace, () => traceSpan('failing', () => Promise.reject(new Error('async')))),
    ).rejects.toThrow('async');

    expect(trace.spans[0]).toMatchObject({ name: 'failing', status: 'error' });
  });

  it.each([
    ['403 Forbidden', new ForbiddenException(), 'denied'],
    ['404 Not Found', new NotFoundException(), 'error'],
    ['500 Internal', new InternalServerErrorException(), 'error'],
    ['a bare TypeError', new TypeError('nope'), 'error'],
  ])('closes a span that threw %s as %s', (_label, error, expected) => {
    const trace = makeTrace();

    expect(() =>
      TraceContext.run(trace, () =>
        traceSpan('guard', () => {
          throw error;
        }),
      ),
    ).toThrow();

    expect(trace.spans[0].status).toBe(expected);
  });

  it('treats 401 and 429 as denied too — the chain refusing is not the chain failing', () => {
    const trace = makeTrace();

    for (const status of [401, 429]) {
      expect(() =>
        TraceContext.run(trace, () =>
          traceSpan('guard', () => {
            throw new (class extends ForbiddenException {
              getStatus(): number {
                return status;
              }
            })();
          }),
        ),
      ).toThrow();
    }

    expect(trace.spans.map((span) => span.status)).toEqual(['denied', 'denied']);
  });

  it('carries attributes, merging the ones supplied at close', () => {
    const trace = makeTrace();

    TraceContext.run(trace, () => {
      const span = startSpan('permission.check', { entity: 'campaign' });
      span.end('ok', { cacheHit: true });
    });

    expect(trace.spans[0].attributes).toEqual({ entity: 'campaign', cacheHit: true });
  });

  it('omits the attributes key entirely when there are none, rather than emitting {}', () => {
    const trace = makeTrace();
    TraceContext.run(trace, () => traceSpan('bare', () => undefined));
    expect(trace.spans[0]).not.toHaveProperty('attributes');
  });

  it('nests: an inner span is recorded before the outer one completes it', () => {
    const trace = makeTrace();

    TraceContext.run(trace, () =>
      traceSpan('outer', () => {
        traceSpan('inner', () => undefined);
      }),
    );

    // Completion order, which is what a waterfall renders from.
    expect(trace.spans.map((span) => span.name)).toEqual(['inner', 'outer']);
    expect(trace.spans[1].durationMs).toBeGreaterThanOrEqual(trace.spans[0].durationMs);
  });

  it('honours the span cap, so a looping handler cannot exhaust memory', () => {
    const trace = makeTrace();

    TraceContext.run(trace, () => {
      for (let i = 0; i < MAX_SPANS_PER_REQUEST + 25; i += 1) traceSpan(`s${i}`, () => undefined);
    });

    expect(trace.spans).toHaveLength(MAX_SPANS_PER_REQUEST);
  });
});

describe('startSpan', () => {
  it('is idempotent — ending twice records one span, not two', () => {
    const trace = makeTrace();

    TraceContext.run(trace, () => {
      const span = startSpan('twice');
      span.end('ok');
      span.end('error');
    });

    expect(trace.spans).toHaveLength(1);
    expect(trace.spans[0].status).toBe('ok');
  });

  it('returns a shared no-op span outside a request, and ending it is harmless', () => {
    const span = startSpan('nothing');
    expect(span.spanId).toBe('');
    expect(() => span.end()).not.toThrow();
    expect(startSpan('nothing')).toBe(span);
  });

  it('defaults the status to ok when end() is called with no argument', () => {
    const trace = makeTrace();
    TraceContext.run(trace, () => startSpan('defaulted').end());
    expect(trace.spans[0].status).toBe('ok');
  });
});

describe('recordSpan', () => {
  it('records an already-measured duration', () => {
    const trace = makeTrace();

    TraceContext.run(trace, () => recordSpan(`${DB_SPAN_PREFIX}select`, 4.5, 'ok', { table: 't' }));

    expect(trace.spans[0]).toMatchObject({
      name: 'db.select',
      durationMs: 4.5,
      status: 'ok',
      attributes: { table: 't' },
    });
  });

  it('back-dates startedAtMs so the span sits where it happened on the timeline', () => {
    const trace = makeTrace();
    TraceContext.run(trace, () => recordSpan('db.select', 1000));
    // The request is microseconds old, so a 1000 ms span cannot have started after it began.
    expect(trace.spans[0].startedAtMs).toBe(0);
  });

  it('defaults to ok and omits absent attributes', () => {
    const trace = makeTrace();
    TraceContext.run(trace, () => recordSpan('db.select', 1));
    expect(trace.spans[0].status).toBe('ok');
    expect(trace.spans[0]).not.toHaveProperty('attributes');
  });

  it('is a no-op outside a request', () => {
    expect(() => recordSpan('db.select', 1)).not.toThrow();
  });
});

describe('SpanService', () => {
  const service = new SpanService();

  it('delegates measure, start, record and timeline to the free functions', async () => {
    const trace = makeTrace();

    await TraceContext.run(trace, async () => {
      expect(service.measure('a', () => 1)).toBe(1);
      service.start('b').end();
      service.record('c', 2);
      service.record('d', 3, 'error', { note: 'x' });
      expect(service.timeline().map((span) => span.name)).toEqual(['a', 'b', 'c', 'd']);
    });

    expect(trace.spans).toHaveLength(4);
    expect(trace.spans[3]).toMatchObject({ status: 'error', attributes: { note: 'x' } });
  });

  it('returns an empty timeline outside a request', () => {
    expect(service.timeline()).toEqual([]);
  });

  it('passes attributes through measure', () => {
    const trace = makeTrace();
    TraceContext.run(trace, () => service.measure('m', () => 1, { k: 'v' }));
    expect(trace.spans[0].attributes).toEqual({ k: 'v' });
  });
});

describe('CHAIN_SPAN', () => {
  it('names every stage 08-OBSERVABILITY.md §5 draws', () => {
    expect(Object.values(CHAIN_SPAN)).toEqual([
      'csrf.verify',
      'jwt.verify',
      'session.validate',
      'permission.check',
      'scope.resolve',
      'payload.decrypt',
      'audit.write',
      'response.mask',
      'response.encrypt',
    ]);
  });
});
