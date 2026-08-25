/**
 * T-065 — the SPA's half of "a campaign date is a calendar date".
 *
 * ### What makes this file different from the one it replaces
 *
 * The rendering bug it closes had e2e coverage that *passed*: T-050's `timezone.spec.ts` compared
 * one browser context against another and, before the fix, correctly reported them different. What
 * did **not** exist was any assertion that could fail in a single run — `formatDay` was
 * `new Date(iso).toLocaleDateString()`, and a unit test for it would have had to restate whatever
 * the runner's own timezone produced. That is a change-detector, not a test (AGENT-PROTOCOL §3).
 *
 * So every expectation here is an absolute string, and the property under test is that **no
 * timezone can change it**. Two mechanisms enforce that:
 *
 *  1. `formatCalendarDate` never constructs a `Date`, so there is nothing for a timezone to act
 *     on. The `DOES NOT CONTAIN Date` assertion below is deliberately structural.
 *  2. The DoD runs this file under four pinned zones spanning UTC−11 to UTC+13:
 *     `TZ=Pacific/Midway npx vitest run src/features/campaigns/campaignDate.test.ts`, and so on.
 *     Setting `process.env.TZ` *inside* a run does not work — Node caches the zone, which the
 *     back-end's `campaign-date.spec.ts` header documents in full after the first version of that
 *     file was caught doing exactly that.
 */
import { describe, expect, it } from 'vitest';
import { formatCalendarDate, formatCalendarDateRange, toDateInputValue } from './campaignDate';

/** Read once, at a fixed February instant — `getTimezoneOffset` is a function of the date. */
const AMBIENT_OFFSET_MINUTES = new Date('2027-02-15T12:00:00Z').getTimezoneOffset();

describe('the harness', () => {
  it('is running somewhere a naive implementation would be wrong', () => {
    // Not decoration: it states why the constants below are worth asserting. Under
    // `TZ=Pacific/Midway` this branch is taken and `new Date('2027-02-15').getDate()` is 14, so a
    // `toLocaleDateString`-based formatter could not pass this file.
    const utcMidnight = new Date('2027-02-15T00:00:00.000Z');
    expect(utcMidnight.toISOString().slice(0, 10)).toBe('2027-02-15');
    if (AMBIENT_OFFSET_MINUTES > 0) expect(utcMidnight.getDate()).toBe(14);
    if (AMBIENT_OFFSET_MINUTES < 0) expect(utcMidnight.getDate()).toBe(15);
  });
});

describe('formatCalendarDate', () => {
  it.each([
    ['2027-01-15', '15 Jan 2027'],
    ['2027-02-15', '15 Feb 2027'],
    // The exact pair from T-050's reproduction — the campaign that read as ending on the 16th.
    ['2027-02-16', '16 Feb 2027'],
    // TC-6 — a year boundary, where an off-by-one hour becomes an off-by-one year.
    ['2027-12-31', '31 Dec 2027'],
    ['2028-01-01', '1 Jan 2028'],
    // Leading zeros are stripped from the day but never from the month name.
    ['2027-03-05', '5 Mar 2027'],
    ['2028-02-29', '29 Feb 2028'],
  ])('renders %s as %s in every timezone', (input, expected) => {
    expect(formatCalendarDate(input)).toBe(expected);
  });

  it('never constructs a Date, which is the only reason the above can be true', () => {
    // Structural, on purpose. Rewriting this as `toLocaleDateString(undefined, { timeZone:
    // 'UTC' })` would keep every assertion above green while reintroducing a `Date` — and the
    // next person to drop the `timeZone` option reintroduces the whole bug. The absence of the
    // constructor is therefore the invariant worth pinning, not just the output.
    const source = formatCalendarDate.toString();
    expect(source).not.toContain('new Date');
    expect(source).not.toContain('toLocale');
    expect(source).not.toContain('Intl');
  });

  it('returns anything that is not a calendar date unchanged, rather than guessing a day', () => {
    // A legacy instant is shown verbatim: ugly and self-evidently wrong beats a plausible wrong
    // day, which is what a `Date` round-trip would produce.
    expect(formatCalendarDate('2027-02-15T23:59:59+05:30')).toBe('2027-02-15T23:59:59+05:30');
    expect(formatCalendarDate('')).toBe('');
    expect(formatCalendarDate('2027-13-01')).toBe('2027-13-01');
  });
});

describe('formatCalendarDateRange', () => {
  it('TC-2/TC-3: the reproduction case reads the same in every zone', () => {
    // The literal string from T-065's evidence block, in its fixed form. Under `TZ=UTC` and
    // `TZ=Asia/Kolkata` this used to be "1/15/2027 to 2/15/2027" and "1/15/2027 to 2/16/2027".
    expect(formatCalendarDateRange('2027-01-15', '2027-02-15')).toBe('15 Jan 2027 – 15 Feb 2027');
  });

  it('TC-5: the start date is rendered by the same function as the end date', () => {
    // The pair moves together or not at all (T-065 implementation note 4).
    expect(formatCalendarDateRange('2027-12-31', '2027-12-31')).toBe('31 Dec 2027 – 31 Dec 2027');
  });
});

describe('toDateInputValue', () => {
  it('passes a calendar date to <input type="date"> untouched', () => {
    expect(toDateInputValue('2027-02-15')).toBe('2027-02-15');
    expect(toDateInputValue('2027-12-31')).toBe('2027-12-31');
  });

  it('reads a legacy instant as its UTC day — the day it is now stored as', () => {
    expect(toDateInputValue('2027-02-15T00:00:00.000Z')).toBe('2027-02-15');
  });

  it('blanks an unreadable value rather than handing the input something it will silently drop', () => {
    expect(toDateInputValue('not a date')).toBe('');
  });
});
