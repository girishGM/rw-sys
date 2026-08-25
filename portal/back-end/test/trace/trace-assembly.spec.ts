/**
 * T-045 — pure-function coverage for `RowBudget` (implementation note 8) and `deriveTimeline`
 * (implementation note 6, TC-13). No Nest, no Sequelize, no database — see `trace-assembly.ts`'s
 * own header for why that split exists.
 */
import {
  deriveTimeline,
  emptySummary,
  RowBudget,
  type RawLogLine,
} from '@/modules/trace/trace-assembly';
import { MAX_TRACE_ROWS } from '@/modules/trace/trace.constants';

describe('RowBudget', () => {
  it('starts with the full cap and is not truncated', () => {
    const budget = new RowBudget(10);
    expect(budget.remaining()).toBe(10);
    expect(budget.truncated()).toBe(false);
    expect(budget.fetchLimit()).toBe(11);
  });

  it('defaults to MAX_TRACE_ROWS when no cap is given', () => {
    expect(new RowBudget().remaining()).toBe(MAX_TRACE_ROWS);
  });

  it('rejects a negative or non-integer cap', () => {
    expect(() => new RowBudget(-1)).toThrow();
    expect(() => new RowBudget(1.5)).toThrow();
  });

  it('take() consumes exactly what it is given when under budget', () => {
    const budget = new RowBudget(10);
    const kept = budget.take([1, 2, 3]);
    expect(kept).toEqual([1, 2, 3]);
    expect(budget.remaining()).toBe(7);
    expect(budget.truncated()).toBe(false);
  });

  it('take() does not mistake "exactly filled the budget" for truncation', () => {
    const budget = new RowBudget(3);
    const kept = budget.take([1, 2, 3]);
    expect(kept).toEqual([1, 2, 3]);
    expect(budget.remaining()).toBe(0);
    expect(budget.truncated()).toBe(false);
  });

  it('take() trims and flags truncation when the source exceeds the remaining budget', () => {
    const budget = new RowBudget(3);
    // As a caller would fetch with `limit: budget.fetchLimit()` (4), getting one row "too many".
    const kept = budget.take([1, 2, 3, 4]);
    expect(kept).toEqual([1, 2, 3]);
    expect(budget.remaining()).toBe(0);
    expect(budget.truncated()).toBe(true);
  });

  it('a later source contributes nothing once the budget is exhausted (TC-14)', () => {
    const budget = new RowBudget(2);
    expect(budget.take([1, 2])).toEqual([1, 2]);
    expect(budget.truncated()).toBe(false);

    expect(budget.exhausted()).toBe(true);
    expect(budget.take(['a', 'b', 'c'])).toEqual([]);
    expect(budget.truncated()).toBe(true);
  });

  it('cascades across many sources without ever exceeding the cap (6,000-row scenario)', () => {
    const budget = new RowBudget(5000);
    const sourceA = Array.from({ length: 2000 }, (_, i) => i);
    const sourceB = Array.from({ length: 2000 }, (_, i) => i);
    const sourceC = Array.from({ length: 2000 }, (_, i) => i); // 6,000 rows on offer in total

    const takenA = budget.take(sourceA.slice(0, budget.fetchLimit()));
    const takenB = budget.take(sourceB.slice(0, budget.fetchLimit()));
    const takenC = budget.take(sourceC.slice(0, budget.fetchLimit()));

    expect(takenA).toHaveLength(2000);
    expect(takenB).toHaveLength(2000);
    expect(takenC).toHaveLength(1000);
    expect(takenA.length + takenB.length + takenC.length).toBe(5000);
    expect(budget.truncated()).toBe(true);
    expect(budget.remaining()).toBe(0);
  });
});

describe('deriveTimeline', () => {
  const correlationId = '01J8F3K9QP2M7N';

  it('returns an empty summary and no spans when there are no log lines', () => {
    expect(deriveTimeline(correlationId, [])).toEqual({
      summary: emptySummary(correlationId),
      spans: [],
    });
    expect(deriveTimeline(correlationId, null)).toEqual({
      summary: emptySummary(correlationId),
      spans: [],
    });
  });

  it('returns an empty summary when no line is a completion line', () => {
    const lines: RawLogLine[] = [{ ts: '2026-08-14T09:12:33.000Z', msg: 'guard decision' }];
    expect(deriveTimeline(correlationId, lines).summary).toEqual(emptySummary(correlationId));
  });

  it('reconstructs the summary and spans from a real completion line (TC-1, TC-13)', () => {
    const line: RawLogLine = {
      ts: '2026-08-14T09:12:33.481Z',
      msg: 'request completed',
      correlationId,
      actor: { userId: 42, role: 'maker', sessionId: 'sess-1' },
      scope: { countryId: 3, tenantId: 7, merchantId: null },
      http: {
        method: 'POST',
        route: 'POST /api/v1/campaigns/:id/submit',
        status: 200,
        durationMs: 142,
      },
      spans: [
        { name: 'jwt.verify', startedAtMs: 0.2, durationMs: 0.8, status: 'ok', spanId: 'a1' },
        { name: 'notify.checkers', startedAtMs: 20, durationMs: 98, status: 'ok', spanId: 'a2' },
      ],
    };

    const { summary, spans } = deriveTimeline(correlationId, [line]);

    expect(summary.correlationId).toBe(correlationId);
    expect(summary.durationMs).toBe(142);
    expect(summary.route).toBe('POST /api/v1/campaigns/:id/submit');
    expect(summary.status).toBe(200);
    expect(summary.actor).toEqual({ userId: 42, role: 'maker', sessionId: 'sess-1' });
    expect(summary.scope).toEqual({ countryId: 3, tenantId: 7, merchantId: null });
    // startedAt = ts - durationMs
    expect(summary.startedAt).toBe(new Date(Date.parse(line.ts as string) - 142).toISOString());

    expect(spans).toHaveLength(2);
    // 98ms is 69% of 142ms — well over the 25% SLOW_SPAN_RATIO — and 0.8ms is not.
    expect(spans.find((s) => s.name === 'notify.checkers')?.slow).toBe(true);
    expect(spans.find((s) => s.name === 'jwt.verify')?.slow).toBe(false);
  });

  it('an error span is preserved with its status (TC-2)', () => {
    const line: RawLogLine = {
      ts: '2026-08-14T09:12:33.481Z',
      msg: 'request completed',
      correlationId,
      http: { durationMs: 50, status: 500, route: 'GET /x' },
      spans: [
        { name: 'campaigns.submit', startedAtMs: 1, durationMs: 40, status: 'error', spanId: 'e1' },
      ],
    };

    const { spans } = deriveTimeline(correlationId, [line]);
    expect(spans[0].status).toBe('error');
  });

  it('picks the most recent completion line when a correlation id spans several requests', () => {
    const older: RawLogLine = {
      ts: '2026-08-14T09:00:00.000Z',
      msg: 'request completed',
      http: { durationMs: 10, status: 500 },
      spans: [],
    };
    const newer: RawLogLine = {
      ts: '2026-08-14T09:05:00.000Z',
      msg: 'request completed',
      http: { durationMs: 20, status: 200 },
      spans: [],
    };

    const { summary } = deriveTimeline(correlationId, [older, newer]);
    expect(summary.status).toBe(200);
    expect(summary.durationMs).toBe(20);
  });

  it('also recognises "request aborted" as a completion line', () => {
    const line: RawLogLine = {
      ts: '2026-08-14T09:00:00.000Z',
      msg: 'request aborted',
      http: { durationMs: 5, status: 0 },
      spans: [],
    };
    expect(deriveTimeline(correlationId, [line]).summary.durationMs).toBe(5);
  });

  it('skips a malformed span rather than throwing, and keeps the well-formed ones', () => {
    const line: RawLogLine = {
      ts: '2026-08-14T09:00:00.000Z',
      msg: 'request completed',
      http: { durationMs: 100, status: 200 },
      spans: [
        { name: 'jwt.verify', startedAtMs: 0, durationMs: 1, status: 'ok', spanId: 'ok-1' },
        { name: 'missing-fields-only' },
        'not even an object',
        null,
      ],
    };

    const { spans } = deriveTimeline(correlationId, [line]);
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('jwt.verify');
  });

  it('defaults an unrecognised span status to "ok" rather than dropping the span', () => {
    const line: RawLogLine = {
      ts: '2026-08-14T09:00:00.000Z',
      msg: 'request completed',
      http: { durationMs: 100, status: 200 },
      spans: [
        { name: 'weird', startedAtMs: 0, durationMs: 1, spanId: 's1', status: 'not-a-status' },
      ],
    };

    expect(deriveTimeline(correlationId, [line]).spans[0].status).toBe('ok');
  });

  it('keeps only scalar (or null) attribute values', () => {
    const line: RawLogLine = {
      ts: '2026-08-14T09:00:00.000Z',
      msg: 'request completed',
      http: { durationMs: 100, status: 200 },
      spans: [
        {
          name: 'db.select',
          startedAtMs: 0,
          durationMs: 1,
          spanId: 's1',
          status: 'ok',
          attributes: {
            table: 'campaigns',
            count: 3,
            cached: false,
            dropped: null,
            nested: { a: 1 },
          },
        },
      ],
    };

    expect(deriveTimeline(correlationId, [line]).spans[0].attributes).toEqual({
      table: 'campaigns',
      count: 3,
      cached: false,
      dropped: null,
    });
  });

  it('never marks anything slow when the total duration is zero or unknown', () => {
    const line: RawLogLine = {
      ts: '2026-08-14T09:00:00.000Z',
      msg: 'request completed',
      http: { status: 200 }, // no durationMs
      spans: [{ name: 'x', startedAtMs: 0, durationMs: 50, spanId: 's1', status: 'ok' }],
    };
    expect(deriveTimeline(correlationId, [line]).spans[0].slow).toBe(false);
  });

  it('startedAt is null when ts is unparseable', () => {
    const line: RawLogLine = {
      ts: 'not-a-date',
      msg: 'request completed',
      http: { durationMs: 10, status: 200 },
      spans: [],
    };
    expect(deriveTimeline(correlationId, [line]).summary.startedAt).toBeNull();
  });

  it('startedAt is null when ts is missing entirely, not just unparseable', () => {
    const line: RawLogLine = {
      msg: 'request completed',
      http: { durationMs: 10, status: 200 },
      spans: [],
    };
    expect(deriveTimeline(correlationId, [line]).summary.startedAt).toBeNull();
  });

  it('renders no spans, without throwing, when the completion line carries no spans array at all', () => {
    const line: RawLogLine = {
      ts: '2026-08-14T09:00:00.000Z',
      msg: 'request completed',
      http: { durationMs: 10, status: 200 },
      // no `spans` key
    };
    expect(deriveTimeline(correlationId, [line]).spans).toEqual([]);
  });

  it('picks the only line with a parseable ts when an earlier completion line has none', () => {
    const undated: RawLogLine = {
      msg: 'request completed',
      http: { durationMs: 999, status: 500 },
      spans: [],
    };
    const dated: RawLogLine = {
      ts: '2026-08-14T09:05:00.000Z',
      msg: 'request completed',
      http: { durationMs: 20, status: 200 },
      spans: [],
    };

    // Regardless of array order, the line with a real timestamp wins over one with none.
    expect(deriveTimeline(correlationId, [undated, dated]).summary.status).toBe(200);
    expect(deriveTimeline(correlationId, [dated, undated]).summary.status).toBe(200);
  });
});
