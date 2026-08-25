/**
 * T-065 — campaign dates are calendar dates.
 *
 * ### What these tests are actually for
 *
 * The defect they close was fully green under unit, HTTP *and* e2e coverage before it was found,
 * because every one of those tests ran in a single timezone and asserted the value that timezone
 * produced. AGENT-PROTOCOL §3's rule applies with full force: *"ask of each security-critical
 * test: if the specified value were wrong, would this test still pass?"*
 *
 * Every expectation below is therefore an **absolute constant** — `2027-02-15T00:00:00.000Z`, not
 * "whatever this machine's `Date` says". A constant is only meaningful if the file is run in more
 * than one zone, so the DoD for T-065 runs it four times:
 *
 * ```
 * TZ=UTC              npm test --workspace @reward-portal/back-end -- test/campaigns
 * TZ=Asia/Kolkata     npm test --workspace @reward-portal/back-end -- test/campaigns
 * TZ=Pacific/Auckland npm test --workspace @reward-portal/back-end -- test/campaigns   # UTC+13
 * TZ=Pacific/Midway   npm test --workspace @reward-portal/back-end -- test/campaigns   # UTC−11
 * ```
 *
 * **Flipping `process.env.TZ` inside the run does not work, and the first version of this file
 * tried it.** On this platform Node resolves the zone once and caches it, so all four "zones"
 * silently ran as the machine's own `+08:00` — a four-way change-detector wearing one zone's
 * clothes. {@link runsInTheZoneTheRunnerAsked} is the canary that caught it and now keeps it
 * caught: it fails if `TZ` was set and did not take effect, so a green run in this file is
 * evidence about the zone it claims to be about.
 *
 * ### The second job: agreement with the shared wire contract
 *
 * `campaign-date.ts` deliberately re-states `campaign.schema.ts`'s "which day does this value
 * name" rule, because the barrel that would let it be imported once is another task's owned file
 * (see that file's header). A duplicated rule that drifts is worse than no rule, so the last block
 * runs the *contract* over the same inputs and asserts the two agree — a drift fails here rather
 * than in production.
 */
import { createCampaignRequestSchema } from '@reward-portal/shared';
import {
  calendarDateOf,
  isCampaignDate,
  toCalendarDate,
  toStoredCampaignDate,
} from '@/modules/campaigns/campaign-date';

/**
 * The four zones T-065 names: the two the defect was reproduced in, plus the UTC+13/UTC−11
 * extremes of TC-3. Offsets are read at a **fixed** February instant, because
 * `getTimezoneOffset()` is a function of the date — Auckland is +13 (NZDT) in February and +12 in
 * July, and an offset table that ignored that would be wrong half the year.
 */
const EXPECTED_OFFSET_MINUTES_AT_FEB_NOON_UTC: Readonly<Record<string, number>> = Object.freeze({
  UTC: 0,
  'Asia/Kolkata': -330,
  'Pacific/Auckland': -780,
  'Pacific/Midway': 660,
});

const AMBIENT_OFFSET_MINUTES = new Date('2027-02-15T12:00:00Z').getTimezoneOffset();

/** See this file's header — the canary, not a formality. */
function runsInTheZoneTheRunnerAsked(): void {
  const zone = process.env.TZ;
  const expected = zone === undefined ? undefined : EXPECTED_OFFSET_MINUTES_AT_FEB_NOON_UTC[zone];
  if (expected === undefined) {
    // An unpinned local run (or a zone not in the table). There is nothing to prove about the
    // zone, and failing here would make `npm test` depend on the developer's own clock settings.
    expect(Number.isFinite(AMBIENT_OFFSET_MINUTES)).toBe(true);
    return;
  }
  expect(AMBIENT_OFFSET_MINUTES).toBe(expected);
}

describe('campaign-date — the harness itself', () => {
  it('is running in the timezone the runner asked for', () => {
    runsInTheZoneTheRunnerAsked();
  });

  it('is running in a zone where a naive read would actually be wrong', () => {
    // Not tautological: it states the property that makes the rest of the file worth running.
    // 2027-02-15T00:00:00Z is the 14th anywhere west of UTC and the 15th anywhere east, so any
    // code that reads a stored campaign date through local time gives a different answer in at
    // least one of the four pinned zones — and the constants below would then not all hold.
    const storedMidnight = new Date('2027-02-15T00:00:00.000Z');
    expect(storedMidnight.toISOString().slice(0, 10)).toBe('2027-02-15');
    if (AMBIENT_OFFSET_MINUTES > 0) {
      // West of UTC: local date really is the previous day. This is the branch that proves a
      // `toLocaleDateString()`-based implementation could not pass this file.
      expect(storedMidnight.getDate()).toBe(14);
    }
  });
});

describe('toCalendarDate', () => {
  it('returns a calendar date unchanged', () => {
    expect(toCalendarDate('2027-02-15')).toBe('2027-02-15');
  });

  it.each([
    // The exact pre-T-065 wizard payload, from four browsers. Every one of them means "the 15th",
    // and the pre-fix code stored each as a different instant.
    ['2027-02-15T23:59:59Z', '2027-02-15'],
    ['2027-02-15T23:59:59+05:30', '2027-02-15'],
    ['2027-02-15T23:59:59+13:00', '2027-02-15'],
    ['2027-02-15T23:59:59-11:00', '2027-02-15'],
    ['2027-02-15T00:00:00+08:00', '2027-02-15'],
    ['2027-02-15T00:00:00-05:00', '2027-02-15'],
    // Fractional seconds — what `new Date().toISOString()` produces, which is what T-050's
    // API-level fixtures send.
    ['2027-02-15T16:18:53.123Z', '2027-02-15'],
  ])('reads %s as the day it names in its own offset: %s', (input, expected) => {
    expect(toCalendarDate(input)).toBe(expected);
  });

  it.each([
    // No offset: genuinely ambiguous about which of two days it means, so it is refused rather
    // than guessed at. This is where strictness matters most — a silent guess moves a date a day.
    '2027-02-15T00:00:00',
    '2027-02-30',
    '15/02/2027',
    'tomorrow',
    '',
  ])('refuses %s rather than inventing a day for it', (input) => {
    expect(isCampaignDate(input)).toBe(false);
    expect(() => toCalendarDate(input)).toThrow(RangeError);
  });
});

describe('isCampaignDate', () => {
  it.each([
    '2027-02-15',
    '2028-02-29',
    '2027-02-15T23:59:59+05:30',
    '2027-02-15T16:18:53.123Z',
    '2027-02-15T00:00:00-11:00',
  ])('accepts %s — exactly what POST /campaigns accepts', (value) => {
    expect(isCampaignDate(value)).toBe(true);
  });

  it('answers the same question toCalendarDate answers, for every input', () => {
    // The two are one implementation by construction (`isCampaignDate` calls the other), and this
    // states the property that makes that worth doing: the agent's policy engine must refuse
    // exactly what the API would refuse — no more, so it never blocks a legal campaign, and no
    // less, so it never builds a plan the API then rejects.
    for (const value of [
      '2027-02-15',
      '2027-02-30',
      '2029-02-29',
      '2027-02-15T00:00:00',
      '2027-02-15T00:00:00Z',
      'tomorrow',
      '',
    ]) {
      let converts = true;
      try {
        toCalendarDate(value);
      } catch {
        converts = false;
      }
      expect(isCampaignDate(value)).toBe(converts);
    }
  });
});

describe('toStoredCampaignDate', () => {
  it('TC-4: stores UTC midnight of the day, with no time of day at all', () => {
    // The assertion the whole defect turns on. `23:59:59` in *any* offset must land here.
    expect(toStoredCampaignDate('2027-02-15').toISOString()).toBe('2027-02-15T00:00:00.000Z');
    expect(toStoredCampaignDate('2027-02-15T23:59:59+05:30').toISOString()).toBe(
      '2027-02-15T00:00:00.000Z',
    );
    expect(toStoredCampaignDate('2027-02-15T23:59:59-11:00').toISOString()).toBe(
      '2027-02-15T00:00:00.000Z',
    );
    expect(toStoredCampaignDate('2027-02-15T23:59:59+13:00').toISOString()).toBe(
      '2027-02-15T00:00:00.000Z',
    );
  });

  it('TC-2/TC-3: what is stored reads back as the day that was written', () => {
    for (const day of ['2027-01-15', '2027-02-15', '2027-12-31', '2028-02-29']) {
      expect(calendarDateOf(toStoredCampaignDate(day))).toBe(day);
    }
  });

  it('TC-5: the start date is treated identically to the end date', () => {
    // The pair has to move together or not at all — a fix that made them inconsistent with each
    // other would be worse than the bug (T-065 implementation note 4).
    const start = toStoredCampaignDate('2027-01-15');
    const end = toStoredCampaignDate('2027-02-15');
    expect(start.toISOString()).toBe('2027-01-15T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-02-15T00:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(31 * 86_400_000);
  });

  it('TC-6: a campaign ending 31 December is still 31 December', () => {
    // Year boundaries are where an off-by-one hour becomes an off-by-one *year*.
    expect(calendarDateOf(toStoredCampaignDate('2027-12-31'))).toBe('2027-12-31');
    expect(calendarDateOf(toStoredCampaignDate('2027-12-31T23:59:59+13:00'))).toBe('2027-12-31');
    expect(calendarDateOf(toStoredCampaignDate('2028-01-01T00:00:00-11:00'))).toBe('2028-01-01');
  });
});

describe('calendarDateOf', () => {
  it('reads the stored instant as its UTC day, never the server’s local day', () => {
    // 2027-02-15T00:00:00Z is the 14th in Midway and the 15th in Auckland. A local read would
    // serve two different dates from two servers holding one row.
    expect(calendarDateOf(new Date('2027-02-15T00:00:00.000Z'))).toBe('2027-02-15');
    expect(calendarDateOf(new Date('2027-12-31T00:00:00.000Z'))).toBe('2027-12-31');
  });

  it('reports a legacy row carrying a time of day as its UTC day', () => {
    // Not a supported state, but a readable one — see T-065 TC-8 and the backfill note in the
    // completion report.
    expect(calendarDateOf(new Date('2027-02-15T18:29:59.000Z'))).toBe('2027-02-15');
  });
});

describe('agreement with the shared wire contract', () => {
  const base = { campaignCode: 'TZ_CHECK', name: 'Timezone check' };

  /** Far enough ahead that "not in the past" is never the reason a case below fails. */
  const START = '2099-02-15';

  it('accepts a single-day campaign — the end date is the last active day, inclusive', () => {
    expect(
      createCampaignRequestSchema.safeParse({ ...base, startDate: START, endDate: START }).success,
    ).toBe(true);
  });

  it('refuses an end date before the start date', () => {
    expect(
      createCampaignRequestSchema.safeParse({
        ...base,
        startDate: '2099-02-15',
        endDate: '2099-02-14',
      }).success,
    ).toBe(false);
  });

  it.each(['2099-02-15T23:59:59+05:30', '2099-02-15T00:00:00-11:00', '2099-02-15T23:59:59+13:00'])(
    'agrees with the contract that %s is the 15th — not the 14th, not the 16th',
    (instant) => {
      // The cross-check that pins the two implementations together. If the contract read this
      // instant as the 16th, an end date of the 15th would be "before" the start and be refused;
      // if it read it as the 14th, an end date of the 14th would be accepted. Only agreement with
      // `toCalendarDate` makes all three of these hold at once.
      expect(toCalendarDate(instant)).toBe('2099-02-15');
      expect(
        createCampaignRequestSchema.safeParse({
          ...base,
          startDate: instant,
          endDate: '2099-02-15',
        }).success,
      ).toBe(true);
      expect(
        createCampaignRequestSchema.safeParse({
          ...base,
          startDate: instant,
          endDate: '2099-02-14',
        }).success,
      ).toBe(false);
    },
  );

  it('still refuses an instant with no offset, in both implementations', () => {
    expect(isCampaignDate('2099-02-15T00:00:00')).toBe(false);
    expect(
      createCampaignRequestSchema.safeParse({
        ...base,
        startDate: '2099-02-15T00:00:00',
        endDate: '2099-03-15',
      }).success,
    ).toBe(false);
  });

  it('refuses a well-shaped day that does not exist, in both implementations', () => {
    expect(isCampaignDate('2099-02-30')).toBe(false);
    expect(
      createCampaignRequestSchema.safeParse({
        ...base,
        startDate: '2099-02-30',
        endDate: '2099-03-15',
      }).success,
    ).toBe(false);
  });

  it('accepts today as a start date in every zone, and refuses a day past everywhere', () => {
    // The past-date guard has to be permissive enough for a maker whose "today" is still the
    // previous UTC day (Honolulu) and strict enough to catch a genuinely stale date. Computed
    // from the clock rather than hard-coded, because "today" is the one value a constant cannot
    // express — the bounds either side of it are what is asserted.
    const now = Date.now();
    const dayAt = (offsetMs: number): string => new Date(now + offsetMs).toISOString().slice(0, 10);

    expect(
      createCampaignRequestSchema.safeParse({
        ...base,
        startDate: dayAt(0),
        endDate: dayAt(30 * 86_400_000),
      }).success,
    ).toBe(true);
    expect(
      createCampaignRequestSchema.safeParse({
        ...base,
        startDate: dayAt(-3 * 86_400_000),
        endDate: dayAt(30 * 86_400_000),
      }).success,
    ).toBe(false);
  });
});
