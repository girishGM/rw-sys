/**
 * T-007 — `UI-UX-DESIGN.md` "Content rules": campaign dates use a `"Mon D – Mon D, YYYY"` range
 * format (e.g. "Jun 1 – Aug 31, 2026"). Formatted in UTC throughout: `tracking-service`'s
 * `startDate`/`endDate` are plain `YYYY-MM-DD` strings (the real `reward_config` date columns,
 * passed through unchanged), which `Date`'s own ISO parser already treats as UTC midnight —
 * formatting in the viewer's local zone instead could shift the displayed day by one depending on
 * where the demo happens to run.
 */
const MONTH_DAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const MONTH_DAY_YEAR_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatDateRange(startDate: string, endDate: string): string {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();

  const startPart = sameYear
    ? MONTH_DAY_FORMATTER.format(start)
    : MONTH_DAY_YEAR_FORMATTER.format(start);
  const endPart = MONTH_DAY_YEAR_FORMATTER.format(end);

  return `${startPart} – ${endPart}`;
}
