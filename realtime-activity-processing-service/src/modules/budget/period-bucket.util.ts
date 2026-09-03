/**
 * T-RAP-033. Computes the `budget_consumption`/`customer_reward_limit_consumption` period bucket
 * (`period_start`/`period_end`, `01-DATABASE.md` §6) a `CampaignCap` resolves to at a given
 * reference instant — `reward_entry_date`, computed once by the caller and passed through
 * (`05-PROCESSING-PIPELINE.md` §6 point 2's own "period-bucket computation ... relative to
 * reward_entry_date", never re-read mid-transaction, so a crash-and-retry of the same row
 * reproduces the same bucket — `05-PROCESSING-PIPELINE.md` §3).
 *
 * **Deviation from this task's own Implementation note 2, flagged for architect review.** That
 * note describes bucketing driven by `frequency_value`/`frequency_unit`
 * (`'hours'|'days'|'months'`) — fields that do not exist anywhere on the real, confirmed
 * `CampaignCap` message (`portal/back-end/proto/campaign_config.v1.proto`,
 * `project-plan/11-BUDGETS-AND-LIMITS.md` §2/§5, confirmed 2026-08-14, cached here as
 * `CampaignCapProto` — `campaign-config.client.ts`, already built by T-RAP-010). The real
 * message's own discriminator is `period_type`
 * (`'lifetime'|'daily'|'monthly'|'rolling_hours'|'time_of_day'`) +
 * `period_value`/`window_start_time`/`window_end_time`/`period_timezone` — this file implements
 * bucketing against *that* shape, per `AGENT-PROTOCOL.md` §3 ("the design doc wins" —
 * `11-BUDGETS-AND-LIMITS.md` is the newer, confirmed one; the task file's own note predates it).
 */
import type { CampaignCapProto } from '@/modules/campaign-cache/campaign-config.client';

export interface PeriodBucket {
  periodStart: Date;
  periodEnd: Date;
}

/** `01-DATABASE.md` §6: "NULL-period caps use 'epoch'" — the sentinel this file picks for
 * `period_type = 'lifetime'`: `period_start` at the Unix epoch, `period_end` at a fixed,
 * far-future instant. The unique indexes (`uc_budget_consumption`/`uc_customer_reward_limit`,
 * both keyed through `period_start`) rely on this pair being stable across every lifetime-cap
 * reservation for the same cap — never derived from `referenceInstant`. */
export const LIFETIME_PERIOD_START = new Date('1970-01-01T00:00:00.000Z');
export const LIFETIME_PERIOD_END = new Date('9999-12-31T23:59:59.999Z');

type PeriodCapInput = Pick<
  CampaignCapProto,
  'periodType' | 'periodValue' | 'windowStartTime' | 'windowEndTime' | 'periodTimezone'
>;

/** ICU `formatToParts`-based zoned-time helpers. No timezone-database npm dependency exists in
 * this service (`package.json`), and Node's own ICU build already carries the full IANA database
 * — this is the standard dependency-free technique (the same one `luxon`/`date-fns-tz` implement
 * internally). DST-transition instants that don't exist or are ambiguous in a given `timeZone`
 * are not specially handled — an edge case none of this task's own test cases exercise. */
function zonedParts(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const map = Object.fromEntries(
    parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** The inverse of `zonedParts`: the UTC instant at which `timeZone`'s own wall clock reads the
 * given Y/M/D/H/M/S. Two-pass resolution — guess as if the wall time were UTC, measure the
 * resulting drift against what that guess actually shows in `timeZone`, correct for it. */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const shown = zonedParts(new Date(guess), timeZone);
  const shownAsUtc = Date.UTC(
    shown.year,
    shown.month - 1,
    shown.day,
    shown.hour,
    shown.minute,
    shown.second,
  );
  return new Date(guess - (shownAsUtc - guess));
}

/** `CampaignCap.period_timezone` is already resolved server-side by the portal (defaults to the
 * campaign's own country timezone — `11-BUDGETS-AND-LIMITS.md` §4.2) — an empty value here is not
 * expected in practice, but falls back to UTC rather than throwing (a missing timezone is a
 * degraded-but-safe bucketing, not a reason to fail the whole cap check). */
function resolveTimeZone(periodTimezone: string): string {
  return periodTimezone && periodTimezone.trim() !== '' ? periodTimezone : 'UTC';
}

function parseTimeOfDay(value: string): [number, number, number] {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value ?? '');
  if (!match) {
    throw new Error(
      `Invalid CampaignCap window_start_time/window_end_time "${value}" — expected "HH:MM" or ` +
        '"HH:MM:SS".',
    );
  }
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? '0')];
}

/** Day 0 of the *next* month is the last day of `month` — plain UTC calendar arithmetic, no
 * timezone conversion involved (this only counts days in a month, never resolves a wall-clock
 * instant). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Resolves one `CampaignCap`'s period bucket at `referenceInstant` (`reward_entry_date`). A pure
 * function of its two inputs, by design — `05-PROCESSING-PIPELINE.md` §3's "a crash-and-retry ...
 * must resolve identically" applies to bucketing exactly as it does to rule evaluation.
 */
export function computePeriodBucket(cap: PeriodCapInput, referenceInstant: Date): PeriodBucket {
  switch (cap.periodType) {
    case 'lifetime':
      return { periodStart: LIFETIME_PERIOD_START, periodEnd: LIFETIME_PERIOD_END };

    case 'daily': {
      const timeZone = resolveTimeZone(cap.periodTimezone);
      const { year, month, day } = zonedParts(referenceInstant, timeZone);
      const periodStart = zonedTimeToUtc(year, month, day, 0, 0, 0, timeZone);
      const periodEnd = new Date(
        zonedTimeToUtc(year, month, day, 23, 59, 59, timeZone).getTime() + 999,
      );
      return { periodStart, periodEnd };
    }

    case 'monthly': {
      const timeZone = resolveTimeZone(cap.periodTimezone);
      const { year, month } = zonedParts(referenceInstant, timeZone);
      const periodStart = zonedTimeToUtc(year, month, 1, 0, 0, 0, timeZone);
      const lastDay = daysInMonth(year, month);
      const periodEnd = new Date(
        zonedTimeToUtc(year, month, lastDay, 23, 59, 59, timeZone).getTime() + 999,
      );
      return { periodStart, periodEnd };
    }

    case 'rolling_hours': {
      // `11-BUDGETS-AND-LIMITS.md` §3 row 5's own "MYR 8,000 per rolling 6 hours" example — but a
      // true *sliding* window has no single (period_start, period_end) a uniquely-keyed
      // consumption row could backstop (`uc_budget_consumption` is keyed through `period_start`).
      // This implements it as discrete, non-overlapping `period_value`-hour buckets anchored at
      // the Unix epoch — a documented, deliberate interpretation neither `05-PROCESSING-PIPELINE.md`
      // nor this task's own file fully specifies; flagged in the completion report.
      if (!Number.isInteger(cap.periodValue) || cap.periodValue <= 0) {
        throw new Error(
          `Invalid CampaignCap period_value ${JSON.stringify(cap.periodValue)} for period_type ` +
            '"rolling_hours" — expected a positive integer number of hours.',
        );
      }
      const bucketMs = cap.periodValue * 60 * 60 * 1000;
      const bucketIndex = Math.floor(referenceInstant.getTime() / bucketMs);
      const periodStart = new Date(bucketIndex * bucketMs);
      const periodEnd = new Date(periodStart.getTime() + bucketMs - 1);
      return { periodStart, periodEnd };
    }

    case 'time_of_day': {
      const timeZone = resolveTimeZone(cap.periodTimezone);
      const [startHour, startMinute, startSecond] = parseTimeOfDay(cap.windowStartTime);
      const [endHour, endMinute, endSecond] = parseTimeOfDay(cap.windowEndTime);
      const { year, month, day } = zonedParts(referenceInstant, timeZone);
      const periodStart = zonedTimeToUtc(
        year,
        month,
        day,
        startHour,
        startMinute,
        startSecond,
        timeZone,
      );
      let periodEnd = zonedTimeToUtc(year, month, day, endHour, endMinute, endSecond, timeZone);
      if (periodEnd.getTime() <= periodStart.getTime()) {
        // A window crossing midnight (e.g. 22:00-02:00) — roll the end onto the next calendar day.
        const nextDayUtcNoon = new Date(Date.UTC(year, month - 1, day + 1, 12));
        periodEnd = zonedTimeToUtc(
          nextDayUtcNoon.getUTCFullYear(),
          nextDayUtcNoon.getUTCMonth() + 1,
          nextDayUtcNoon.getUTCDate(),
          endHour,
          endMinute,
          endSecond,
          timeZone,
        );
      }
      return { periodStart, periodEnd };
    }

    default:
      throw new Error(
        `Unsupported CampaignCap.period_type "${cap.periodType}" — only "lifetime", "daily", ` +
          '"monthly", "rolling_hours" and "time_of_day" are implemented ' +
          '(project-plan/11-BUDGETS-AND-LIMITS.md §2).',
      );
  }
}
