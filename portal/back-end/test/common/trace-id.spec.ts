/**
 * T-014 — `resolveTraceId`, the seam T-019 takes over.
 *
 * Two security-relevant properties, both from 08-OBSERVABILITY.md §1: a client-supplied
 * correlation id is **validated before use** (an unvalidated header with a newline in it is log
 * injection — forged log entries), and the resolved value is **stable for the request**, which
 * is what makes TC-16's "the traceId in the response matches the one in the log" true rather
 * than approximately true.
 */
import { CORRELATION_HEADER, isValidCorrelationId, resolveTraceId } from '@/common/errors';
import { requestDouble } from './support/http-doubles';

describe('resolveTraceId', () => {
  it('prefers a correlation id already established on the request (T-019’s middleware)', () => {
    const request = requestDouble();
    (request as { correlationId?: string }).correlationId = '01J8F3K9QP2M7N';

    expect(resolveTraceId(request)).toBe('01J8F3K9QP2M7N');
  });

  it('accepts a well-formed client header', () => {
    const request = requestDouble({ headers: { [CORRELATION_HEADER]: 'abc-123_XYZ' } });
    expect(resolveTraceId(request)).toBe('abc-123_XYZ');
  });

  it.each([
    ['a newline — log injection', 'ok-value\nfake: log line'],
    ['a space', 'two words'],
    ['too short', 'abc'],
    ['too long', 'x'.repeat(65)],
    ['a semicolon', 'abc;drop'],
    ['an empty string', ''],
    ['a repeated header (array)', ['one-value', 'two-value']],
    ['a number', 42],
  ])('rejects %s and generates its own', (_name, header) => {
    const request = requestDouble({ headers: { [CORRELATION_HEADER]: header } as never });

    const traceId = resolveTraceId(request);

    expect(traceId).not.toBe(header);
    expect(isValidCorrelationId(traceId)).toBe(true);
  });

  it('is stable across calls on the same request', () => {
    const request = requestDouble();
    expect(resolveTraceId(request)).toBe(resolveTraceId(request));
  });

  it('differs between requests', () => {
    expect(resolveTraceId(requestDouble())).not.toBe(resolveTraceId(requestDouble()));
  });

  it('answers even with no request at all', () => {
    expect(isValidCorrelationId(resolveTraceId(undefined))).toBe(true);
  });

  it('tolerates a request with no headers object', () => {
    const request = requestDouble();
    (request as { headers?: unknown }).headers = undefined;

    expect(isValidCorrelationId(resolveTraceId(request))).toBe(true);
  });

  it('ignores a non-string correlationId planted on the request', () => {
    const request = requestDouble();
    (request as { correlationId?: unknown }).correlationId = { toString: () => 'nope-nope' };

    expect(resolveTraceId(request)).not.toBe('nope-nope');
  });
});
