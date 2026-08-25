/**
 * T-045 — `TRACE_CORRELATION_ID_PATTERN` is deliberately a second copy of `common/errors
 * /trace-id.ts`'s `CORRELATION_ID_PATTERN` (that file's header explains why: T-014's error
 * envelope needed the minimum before T-019's real tracing layer existed) and of the shared
 * package's own copy (the front end cannot import from `back-end/src`). This suite is what keeps
 * three independent declarations of "08-OBSERVABILITY.md §1, verbatim" from silently drifting
 * apart.
 */
import { CORRELATION_ID_PATTERN } from '@/common/errors/trace-id';
import { TRACE_CORRELATION_ID_PATTERN } from '@/modules/trace/trace.constants';
import { TRACE_CORRELATION_ID_PATTERN as SHARED_PATTERN } from '@reward-portal/shared';

describe('TRACE_CORRELATION_ID_PATTERN parity', () => {
  it('is byte-for-byte identical to common/errors/trace-id.ts', () => {
    expect(TRACE_CORRELATION_ID_PATTERN.source).toBe(CORRELATION_ID_PATTERN.source);
    expect(TRACE_CORRELATION_ID_PATTERN.flags).toBe(CORRELATION_ID_PATTERN.flags);
  });

  it('is byte-for-byte identical to the shared package copy', () => {
    expect(TRACE_CORRELATION_ID_PATTERN.source).toBe(SHARED_PATTERN.source);
  });

  it('is exactly 08-OBSERVABILITY.md §1', () => {
    expect(TRACE_CORRELATION_ID_PATTERN.source).toBe('^[A-Za-z0-9_-]{8,64}$');
  });
});
