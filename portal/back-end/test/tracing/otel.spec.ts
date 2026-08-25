/**
 * T-019 — the W3C Trace Context wire format.
 *
 * `traceparent` is an attacker-controlled header that ends up in a log line and in an **outbound
 * request header**, so the parser gets the same treatment as the correlation-id validator: every
 * rejection path is asserted by name, and the acceptance path is asserted to be byte-exact
 * against the W3C recommendation rather than "close enough".
 *
 * TC-22 has its form here (`outboundTraceHeaders`); its over-HTTP counterpart is in
 * `tracing.http.spec.ts`.
 *
 * Control characters are written as `String.fromCharCode(...)` rather than as literals, so this
 * source file itself stays free of the bytes it is testing for — a spec containing a raw NUL is a
 * spec that breaks `grep`, `scan:secrets` and every diff tool that reads it.
 */
import {
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  TRACE_FLAG_SAMPLED,
  formatTraceparent,
  newSpanId,
  newTraceId,
  outboundTraceHeaders,
  parseTraceparent,
  sanitiseTracestate,
} from '@/common/tracing/otel';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(127);

describe('newTraceId / newSpanId', () => {
  it('produces 32 and 16 lower-case hex characters', () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('never produces the all-zero sentinel, which W3C defines as "invalid"', () => {
    // The guarantee is structural (the low bit of the first byte is set), not probabilistic, so
    // the loop is a demonstration; the proof is that the first byte is always odd.
    for (let i = 0; i < 200; i += 1) {
      expect(newTraceId()).not.toBe('0'.repeat(32));
      expect(newSpanId()).not.toBe('0'.repeat(16));
      expect(Number.parseInt(newTraceId().slice(0, 2), 16) % 2).toBe(1);
      expect(Number.parseInt(newSpanId().slice(0, 2), 16) % 2).toBe(1);
    }
  });

  it('produces a different value every time', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newTraceId()));
    expect(ids.size).toBe(500);
  });
});

describe('parseTraceparent', () => {
  it('accepts a well-formed version-00 header and reports the sampled flag', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01`)).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      sampled: true,
    });
  });

  it('reads sampled=false when the flag bit is clear', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-00`)?.sampled).toBe(false);
  });

  it('reads the sampled bit rather than the whole octet', () => {
    // `03` = sampled + a future flag. A parser that compared the octet to `01` would drop the
    // sampling decision of every agent that starts using a second flag.
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-03`)?.sampled).toBe(true);
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-02`)?.sampled).toBe(false);
    expect(TRACE_FLAG_SAMPLED).toBe(0x01);
  });

  it('accepts an unknown future version and ignores its trailing fields', () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01-extra`)).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      sampled: true,
    });
  });

  it('rejects a version-00 header with trailing fields — 00 forbids them', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01-extra`)).toBeNull();
  });

  it('rejects version ff, which the specification reserves as invalid', () => {
    expect(parseTraceparent(`ff-${TRACE_ID}-${SPAN_ID}-01`)).toBeNull();
  });

  it('rejects the all-zero trace id and the all-zero span id', () => {
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${SPAN_ID}-01`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}-${'0'.repeat(16)}-01`)).toBeNull();
  });

  it.each([
    ['absent', undefined],
    ['a duplicated header (array)', [`00-${TRACE_ID}-${SPAN_ID}-01`]],
    ['an object', { traceId: TRACE_ID }],
    ['empty', ''],
    ['upper-case hex', `00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`],
    ['a short trace id', `00-${TRACE_ID.slice(0, 30)}-${SPAN_ID}-01`],
    ['a long span id', `00-${TRACE_ID}-${SPAN_ID}ab-01`],
    ['non-hex characters', `00-${'g'.repeat(32)}-${SPAN_ID}-01`],
    ['a newline injection attempt', `00-${TRACE_ID}-${SPAN_ID}-01\nFAKE LOG LINE`],
    ['a SQL comment terminator', `00-${TRACE_ID}-${SPAN_ID}-*/`],
  ])('rejects %s', (_label, value) => {
    expect(parseTraceparent(value)).toBeNull();
  });
});

describe('formatTraceparent', () => {
  it('round-trips through parseTraceparent', () => {
    const header = formatTraceparent(TRACE_ID, SPAN_ID, true);
    expect(header).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
    expect(parseTraceparent(header)).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: true });
  });

  it('emits flags 00 when not sampled', () => {
    expect(formatTraceparent(TRACE_ID, SPAN_ID, false)).toBe(`00-${TRACE_ID}-${SPAN_ID}-00`);
  });
});

describe('sanitiseTracestate', () => {
  it('passes a printable-ASCII value through unchanged', () => {
    expect(sanitiseTracestate('rojo=00f067aa0ba902b7,congo=t61rcWkgMzE')).toBe(
      'rojo=00f067aa0ba902b7,congo=t61rcWkgMzE',
    );
  });

  it.each([
    ['a newline', 'rojo=1\nFAKE'],
    ['a carriage return', 'rojo=1\rFAKE'],
    ['a NUL byte', `rojo=1${NUL}`],
    ['a DEL byte', `rojo=1${DEL}`],
    ['an over-long value', 'a'.repeat(513)],
    ['an empty value', ''],
    ['a non-string', 42],
    ['an array (duplicated header)', ['rojo=1']],
  ])('refuses %s', (_label, value) => {
    expect(sanitiseTracestate(value)).toBeNull();
  });
});

describe('outboundTraceHeaders (TC-22)', () => {
  const context = {
    correlationId: 'abc12345-def6',
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    sampled: true,
  };

  it('propagates traceparent and the correlation id', () => {
    expect(outboundTraceHeaders(context)).toEqual({
      [TRACEPARENT_HEADER]: `00-${TRACE_ID}-${SPAN_ID}-01`,
      'x-correlation-id': 'abc12345-def6',
    });
  });

  it('does NOT propagate the request id — the callee makes its own', () => {
    expect(Object.keys(outboundTraceHeaders(context))).not.toContain('x-request-id');
  });

  it('forwards a well-formed tracestate', () => {
    expect(outboundTraceHeaders({ ...context, tracestate: 'rojo=1' })[TRACESTATE_HEADER]).toBe(
      'rojo=1',
    );
  });

  it('drops a tracestate that could inject a header', () => {
    const headers = outboundTraceHeaders({ ...context, tracestate: 'rojo=1\r\nX-Admin: true' });
    expect(headers[TRACESTATE_HEADER]).toBeUndefined();
  });

  it('omits tracestate when there is none', () => {
    const headers = outboundTraceHeaders({ ...context, tracestate: null });
    expect(headers[TRACESTATE_HEADER]).toBeUndefined();
  });
});
