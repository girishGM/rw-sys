/**
 * T-RAP-033. Pure-logic tests for `computePeriodBucket` — no DB, no network. TC-7 ("a
 * frequency-based cap's period boundary, e.g. exactly at a day rollover") lives here as the
 * `'daily'` cases below.
 */
import {
  computePeriodBucket,
  LIFETIME_PERIOD_END,
  LIFETIME_PERIOD_START,
} from '@/modules/budget/period-bucket.util';

function cap(overrides: {
  periodType: string;
  periodValue?: number;
  windowStartTime?: string;
  windowEndTime?: string;
  periodTimezone?: string;
}) {
  return {
    periodType: overrides.periodType,
    periodValue: overrides.periodValue ?? 0,
    windowStartTime: overrides.windowStartTime ?? '',
    windowEndTime: overrides.windowEndTime ?? '',
    periodTimezone: overrides.periodTimezone ?? '',
  };
}

describe('computePeriodBucket', () => {
  it('lifetime: always the fixed epoch..far-future sentinel, regardless of referenceInstant', () => {
    const a = computePeriodBucket(
      cap({ periodType: 'lifetime' }),
      new Date('2026-03-01T00:00:00Z'),
    );
    const b = computePeriodBucket(
      cap({ periodType: 'lifetime' }),
      new Date('2030-11-05T23:59:59Z'),
    );
    expect(a.periodStart).toEqual(LIFETIME_PERIOD_START);
    expect(a.periodEnd).toEqual(LIFETIME_PERIOD_END);
    expect(b.periodStart).toEqual(LIFETIME_PERIOD_START);
    expect(b.periodEnd).toEqual(LIFETIME_PERIOD_END);
  });

  it('daily (UTC): buckets to midnight..23:59:59.999 UTC of the same calendar day', () => {
    const { periodStart, periodEnd } = computePeriodBucket(
      cap({ periodType: 'daily', periodTimezone: 'UTC' }),
      new Date('2026-03-15T14:30:00.000Z'),
    );
    expect(periodStart.toISOString()).toBe('2026-03-15T00:00:00.000Z');
    expect(periodEnd.toISOString()).toBe('2026-03-15T23:59:59.999Z');
  });

  // TC-7: exactly at a day rollover — two instants either side of midnight (in the cap's own
  // timezone) must land in two different, non-overlapping buckets, never leaking consumption
  // across the boundary.
  it('TC-7: daily rollover — one millisecond either side of midnight lands in different buckets', () => {
    const beforeMidnight = computePeriodBucket(
      cap({ periodType: 'daily', periodTimezone: 'UTC' }),
      new Date('2026-03-15T23:59:59.999Z'),
    );
    const afterMidnight = computePeriodBucket(
      cap({ periodType: 'daily', periodTimezone: 'UTC' }),
      new Date('2026-03-16T00:00:00.000Z'),
    );
    expect(beforeMidnight.periodStart.toISOString()).toBe('2026-03-15T00:00:00.000Z');
    expect(afterMidnight.periodStart.toISOString()).toBe('2026-03-16T00:00:00.000Z');
    expect(beforeMidnight.periodStart.getTime()).not.toBe(afterMidnight.periodStart.getTime());
    expect(beforeMidnight.periodEnd.getTime()).toBeLessThan(afterMidnight.periodStart.getTime());
  });

  it('daily (non-UTC timezone): midnight boundary follows the local wall clock, not UTC', () => {
    // Asia/Kuala_Lumpur is UTC+8 — 2026-03-15T20:00:00Z is already 2026-03-16 local time there.
    const { periodStart, periodEnd } = computePeriodBucket(
      cap({ periodType: 'daily', periodTimezone: 'Asia/Kuala_Lumpur' }),
      new Date('2026-03-15T20:00:00.000Z'),
    );
    expect(periodStart.toISOString()).toBe('2026-03-15T16:00:00.000Z'); // 2026-03-16T00:00:00+08:00
    expect(periodEnd.toISOString()).toBe('2026-03-16T15:59:59.999Z'); // 2026-03-16T23:59:59.999+08:00
  });

  it('daily: falls back to UTC when period_timezone is blank', () => {
    const { periodStart } = computePeriodBucket(
      cap({ periodType: 'daily', periodTimezone: '' }),
      new Date('2026-03-15T10:00:00.000Z'),
    );
    expect(periodStart.toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });

  it('monthly: buckets to the 1st..last day of the calendar month (UTC)', () => {
    const { periodStart, periodEnd } = computePeriodBucket(
      cap({ periodType: 'monthly', periodTimezone: 'UTC' }),
      new Date('2026-02-15T10:00:00.000Z'),
    );
    expect(periodStart.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    // 2026 is not a leap year — February has 28 days.
    expect(periodEnd.toISOString()).toBe('2026-02-28T23:59:59.999Z');
  });

  it('monthly: a leap-year February correctly resolves 29 days', () => {
    const { periodEnd } = computePeriodBucket(
      cap({ periodType: 'monthly', periodTimezone: 'UTC' }),
      new Date('2028-02-10T00:00:00.000Z'),
    );
    expect(periodEnd.toISOString()).toBe('2028-02-29T23:59:59.999Z');
  });

  it('rolling_hours: non-overlapping fixed buckets anchored at the Unix epoch', () => {
    const referenceInstant = new Date('2026-01-01T13:15:00.000Z');
    const { periodStart, periodEnd } = computePeriodBucket(
      cap({ periodType: 'rolling_hours', periodValue: 6 }),
      referenceInstant,
    );
    expect(periodStart.getTime() % (6 * 60 * 60 * 1000)).toBe(0);
    expect(referenceInstant.getTime()).toBeGreaterThanOrEqual(periodStart.getTime());
    expect(referenceInstant.getTime()).toBeLessThanOrEqual(periodEnd.getTime());
    expect(periodEnd.getTime() - periodStart.getTime()).toBe(6 * 60 * 60 * 1000 - 1);
  });

  it('rolling_hours: two instants in different buckets never share a period_start', () => {
    const a = computePeriodBucket(
      cap({ periodType: 'rolling_hours', periodValue: 6 }),
      new Date('2026-01-01T05:59:59.999Z'),
    );
    const b = computePeriodBucket(
      cap({ periodType: 'rolling_hours', periodValue: 6 }),
      new Date('2026-01-01T06:00:00.000Z'),
    );
    expect(a.periodStart.getTime()).not.toBe(b.periodStart.getTime());
  });

  it('rolling_hours: rejects a non-positive-integer period_value', () => {
    expect(() =>
      computePeriodBucket(
        cap({ periodType: 'rolling_hours', periodValue: 0 }),
        new Date('2026-01-01T00:00:00.000Z'),
      ),
    ).toThrow(/period_value/);
  });

  it('time_of_day: a same-day window (e.g. 18:00-22:00 UTC)', () => {
    const { periodStart, periodEnd } = computePeriodBucket(
      cap({
        periodType: 'time_of_day',
        windowStartTime: '18:00',
        windowEndTime: '22:00',
        periodTimezone: 'UTC',
      }),
      new Date('2026-06-10T19:00:00.000Z'),
    );
    expect(periodStart.toISOString()).toBe('2026-06-10T18:00:00.000Z');
    expect(periodEnd.toISOString()).toBe('2026-06-10T22:00:00.000Z');
  });

  it('time_of_day: a window crossing midnight (e.g. 22:00-02:00 UTC) rolls the end to the next day', () => {
    const { periodStart, periodEnd } = computePeriodBucket(
      cap({
        periodType: 'time_of_day',
        windowStartTime: '22:00',
        windowEndTime: '02:00',
        periodTimezone: 'UTC',
      }),
      new Date('2026-06-10T23:00:00.000Z'),
    );
    expect(periodStart.toISOString()).toBe('2026-06-10T22:00:00.000Z');
    expect(periodEnd.toISOString()).toBe('2026-06-11T02:00:00.000Z');
  });

  it('rejects an unsupported period_type', () => {
    expect(() =>
      computePeriodBucket(cap({ periodType: 'weekly' }), new Date('2026-01-01T00:00:00.000Z')),
    ).toThrow(/unsupported.*period_type/i);
  });

  it('is a pure function: the same inputs always resolve to the same bucket (crash-and-retry safety)', () => {
    const input = cap({ periodType: 'daily', periodTimezone: 'America/New_York' });
    const referenceInstant = new Date('2026-07-04T12:00:00.000Z');
    const first = computePeriodBucket(input, referenceInstant);
    const second = computePeriodBucket(input, referenceInstant);
    expect(first).toEqual(second);
  });
});
