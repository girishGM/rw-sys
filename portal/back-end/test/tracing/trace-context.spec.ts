/**
 * T-019 — the `AsyncLocalStorage` that carries the trace, and the bounds on what it accumulates.
 *
 * TC-11 (context survives `await`, `Promise.all`, timers and Sequelize-style callbacks) and TC-12
 * (no bleed between concurrent requests) have their unit form here. Their over-HTTP counterparts,
 * with 100 real concurrent requests as two different users, are in `tracing.http.spec.ts` — both
 * are needed: this file proves the mechanism, that one proves the wiring.
 */
import {
  ANONYMOUS_ACTOR,
  MAX_SPANS_PER_REQUEST,
  TraceContext,
  UNSCOPED,
  appendSpan,
  elapsedMsSince,
  type RequestTrace,
  type SpanRecord,
} from '@/common/tracing/trace-context';
import { makeTrace } from './support/trace-fixtures';

describe('TraceContext', () => {
  it('is inactive outside a run, and every accessor degrades rather than throwing', () => {
    expect(TraceContext.isActive()).toBe(false);
    expect(TraceContext.current()).toBeUndefined();
    expect(TraceContext.correlationId()).toBeNull();
  });

  it('exposes the trace inside a run', () => {
    const trace = makeTrace({ correlationId: 'abcdefgh' });

    TraceContext.run(trace, () => {
      expect(TraceContext.isActive()).toBe(true);
      expect(TraceContext.current()).toBe(trace);
      expect(TraceContext.correlationId()).toBe('abcdefgh');
    });

    expect(TraceContext.isActive()).toBe(false);
  });

  it('returns whatever the callback returns', () => {
    expect(TraceContext.run(makeTrace(), () => 42)).toBe(42);
  });

  describe('TC-11 — the context survives every asynchronous boundary', () => {
    it('survives await', async () => {
      const trace = makeTrace({ correlationId: 'await000' });

      await TraceContext.run(trace, async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(TraceContext.correlationId()).toBe('await000');
      });
    });

    it('survives Promise.all, with every branch seeing the same trace', async () => {
      const trace = makeTrace({ correlationId: 'parallel' });

      const seen = await TraceContext.run(trace, async () =>
        Promise.all(
          Array.from({ length: 20 }, async () => {
            await new Promise((resolve) => setImmediate(resolve));
            return TraceContext.correlationId();
          }),
        ),
      );

      expect(new Set(seen)).toEqual(new Set(['parallel']));
    });

    it('survives a timer and a node-style callback (the Sequelize shape)', async () => {
      const trace = makeTrace({ correlationId: 'callback1' });

      const fromTimer = await TraceContext.run(
        trace,
        () =>
          new Promise<string | null>((resolve) => {
            setTimeout(() => {
              // A library that hands work back through a callback registered inside the run — the
              // shape a Sequelize hook or a `pg` result callback has.
              process.nextTick(() => resolve(TraceContext.correlationId()));
            }, 1);
          }),
      );

      expect(fromTimer).toBe('callback1');
    });

    /**
     * **Does NOT survive** — and this test exists to pin that, because it is the one boundary
     * where the intuition is wrong and the consequence is severe.
     *
     * `AsyncLocalStorage` follows the *async-resource* chain. An `EventEmitter` listener runs in
     * the context of whatever called `emit()`, not the context it was registered in. That is
     * exactly the shape `CorrelationMiddleware` uses for its `res.on('finish')` completion line,
     * where `emit()` comes from Node's socket machinery — so, left alone, the single most
     * important line per request would be the one with no correlation id on it.
     *
     * Found by this test while writing it, not by inspection. The middleware therefore re-enters
     * the store explicitly inside its listener; `correlation.middleware.spec.ts` asserts the
     * result, and this test guards the assumption that makes it necessary.
     */
    it('does NOT survive a bare EventEmitter listener — hence the re-entry in the middleware', async () => {
      const { EventEmitter } = await import('node:events');
      const emitter = new EventEmitter();
      const trace = makeTrace({ correlationId: 'emitter0' });

      const [bare, reentered] = await new Promise<[string | null, string | null]>((resolve) => {
        TraceContext.run(trace, () => {
          emitter.on('done', () => {
            const withoutReentry = TraceContext.correlationId();
            const withReentry = TraceContext.run(trace, () => TraceContext.correlationId());
            resolve([withoutReentry, withReentry]);
          });
        });
        setImmediate(() => emitter.emit('done'));
      });

      expect(bare).toBeNull();
      expect(reentered).toBe('emitter0');
    });
  });

  describe('TC-12 — no bleed between concurrent traces', () => {
    it('keeps 100 interleaved traces separate', async () => {
      const results = await Promise.all(
        Array.from({ length: 100 }, async (_unused, index) => {
          const id = `bleed${String(index).padStart(3, '0')}`;
          return TraceContext.run(makeTrace({ correlationId: id }), async () => {
            // A randomised delay so the traces genuinely interleave rather than running to
            // completion one at a time, which would pass even with a single shared global.
            await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
            return { expected: id, observed: TraceContext.correlationId() };
          });
        }),
      );

      for (const { expected, observed } of results) expect(observed).toBe(expected);
    });

    it('gives each trace its own span list', async () => {
      const traces = [makeTrace(), makeTrace()];

      await Promise.all(
        traces.map(async (trace, index) =>
          TraceContext.run(trace, async () => {
            await new Promise((resolve) => setTimeout(resolve, 2));
            appendSpan(trace, span(`only.in.${index}`));
          }),
        ),
      );

      expect(traces[0].spans.map((s) => s.name)).toEqual(['only.in.0']);
      expect(traces[1].spans.map((s) => s.name)).toEqual(['only.in.1']);
    });
  });
});

describe('appendSpan', () => {
  it('appends in order', () => {
    const trace = makeTrace();
    appendSpan(trace, span('a'));
    appendSpan(trace, span('b'));
    expect(trace.spans.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('stops at MAX_SPANS_PER_REQUEST rather than growing without bound', () => {
    const trace = makeTrace();
    for (let i = 0; i < MAX_SPANS_PER_REQUEST + 50; i += 1) appendSpan(trace, span(`s${i}`));

    expect(trace.spans).toHaveLength(MAX_SPANS_PER_REQUEST);
    // The *first* spans are kept, not the last: a request that looped 10 000 times is diagnosed
    // from how it started, and dropping the head would lose the security chain entirely.
    expect(trace.spans[0].name).toBe('s0');
  });
});

describe('elapsedMsSince', () => {
  it('is monotonic and non-negative', async () => {
    const start = process.hrtime.bigint();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const elapsed = elapsedMsSince(start);

    expect(elapsed).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
  });

  it('rounds to microsecond precision, so a log line is not 15 significant figures', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(String(elapsedMsSince(process.hrtime.bigint()))).toMatch(/^\d+(\.\d{1,3})?$/);
    }
  });
});

describe('the shared empty actor and scope (TC-10)', () => {
  it('has every key present and null, and is frozen', () => {
    expect(ANONYMOUS_ACTOR).toEqual({ userId: null, role: null, sessionId: null });
    expect(UNSCOPED).toEqual({ countryId: null, tenantId: null, merchantId: null });
    expect(Object.isFrozen(ANONYMOUS_ACTOR)).toBe(true);
    expect(Object.isFrozen(UNSCOPED)).toBe(true);
  });

  it('has the keys present — a missing key and a null key are different to a log query', () => {
    expect(Object.keys(ANONYMOUS_ACTOR).sort()).toEqual(['role', 'sessionId', 'userId']);
    expect(Object.keys(UNSCOPED).sort()).toEqual(['countryId', 'merchantId', 'tenantId']);
  });
});

function span(name: string): SpanRecord {
  return { name, startedAtMs: 0, durationMs: 1, status: 'ok', spanId: 'aaaaaaaaaaaaaaaa' };
}

// Type-level assurance that the fixture really is a `RequestTrace` and not a structural
// look-alike that would let this whole file drift from the interface it is testing.
const _typecheck: RequestTrace = makeTrace();
void _typecheck;
