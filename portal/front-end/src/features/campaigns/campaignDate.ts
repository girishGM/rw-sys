/**
 * T-065 — how the SPA reads and writes a campaign's start/end date.
 *
 * ### The rule, in one line
 *
 * A campaign date never becomes a `Date`. Not on the way in, not on the way out.
 *
 * ### Why that is the rule and not merely a preference
 *
 * The same campaign used to render *"1/15/2027 to 2/15/2027"* under `TZ=UTC` and *"1/15/2027 to
 * 2/16/2027"* under `Asia/Kolkata`. Two independent traps combined to do that, and both live in
 * `Date`:
 *
 *  1. **Writing.** `<input type="date">` gives `2027-02-15`, which the wizard converted to
 *     `2027-02-15T23:59:59` **in the browser's own offset** before sending it. A campaign approved
 *     to end on the 15th therefore ran through the 16th for anyone reading it further east.
 *  2. **Reading.** `new Date(iso).toLocaleDateString()` renders an *instant* in the reader's
 *     timezone. `new Date('2027-02-15')` is UTC midnight; `new Date('2027-02-15T00:00:00')` is
 *     local midnight. Both are traps, in opposite directions, and neither is what "15 February"
 *     means.
 *
 * The API now speaks `YYYY-MM-DD` in both directions (T-065), so the correct client is the one
 * that does nothing: send the input's value unchanged, and format the served string as text.
 *
 * {@link formatCalendarDate} therefore builds its output from the string's own characters and
 * never constructs a `Date`. A test that only checked `toLocaleDateString` output under one
 * timezone could not have caught the original bug — `campaignDate.test.ts` runs the real
 * assertion, which is that four zones spanning UTC−11 to UTC+13 produce the same characters.
 */

/** English month abbreviations, indexed by `MM - 1`. v1 ships in English only — 04-FRONTEND.md §7
 * (*"No i18n library is added in v1"*), which also notes that timezone correctness is a
 * data-correctness issue independent of display language. */
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `2027-02-15` → `15 Feb 2027`. The one way a campaign date is shown to a human.
 *
 * Day-month-year with a named month rather than the browser's `toLocaleDateString()`, for two
 * reasons: it is byte-identical in every timezone *and* every locale, and it removes the
 * `2/15/2027`-vs-`15/2/2027` ambiguity — which matters more than usual in a portal whose whole
 * point is that Malaysia, Singapore and the UK read the same screen.
 *
 * Anything that is not a `YYYY-MM-DD` string is returned unchanged. A campaign row written before
 * T-065 and never re-saved could still carry an instant; showing it verbatim is ugly and
 * self-evidently wrong, which is strictly better than silently showing a plausible wrong day.
 */
export function formatCalendarDate(value: string): string {
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (match === null) return value;
  const [, year, month, day] = match;
  const monthName = MONTHS[Number(month) - 1];
  if (monthName === undefined) return value;
  // `Number()` then back to string strips the leading zero: "05" → "5".
  return `${String(Number(day))} ${monthName} ${year}`;
}

/**
 * `15 Feb 2027 – 15 Mar 2027`, the range every campaign surface shows.
 *
 * An en dash with hair spaces, matching what `CampaignsListPage`/`CampaignDetailPage` already
 * rendered — this function exists so those two and the wizard's review step cannot drift apart,
 * which is precisely how the original defect stayed invisible on some screens and not others.
 */
export function formatCalendarDateRange(start: string, end: string): string {
  return `${formatCalendarDate(start)} – ${formatCalendarDate(end)}`;
}

/**
 * A served campaign date as `<input type="date">` wants it — which, now that the API serves
 * `YYYY-MM-DD`, is the value itself.
 *
 * Kept as a named function rather than inlined for the legacy branch: a draft created before
 * T-065 may still be served as an instant if it is read from somewhere that has not been
 * normalised, and the input must not be handed a string it will silently blank out. The UTC day
 * is the right reading of such a value, because that is how it is now stored.
 */
export function toDateInputValue(value: string): string {
  if (CALENDAR_DATE_PATTERN.test(value)) return value;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return '';
  return new Date(parsed).toISOString().slice(0, 10);
}
