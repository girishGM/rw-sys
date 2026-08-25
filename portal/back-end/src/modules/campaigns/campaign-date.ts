/**
 * T-065 — a campaign's start and end are **calendar dates**, and this file is the only place the
 * back end converts between that idea and the `timestamptz` columns it has to live in.
 *
 * ### The defect this exists to close
 *
 * The same campaign read *"1/15/2027 to 2/15/2027"* under `TZ=UTC` and *"1/15/2027 to
 * 2/16/2027"* under `Asia/Kolkata`. Only the end date moved, and only forward, because only the
 * end date was written with a time component near a day boundary: the wizard sent
 * `<day>T23:59:59` **in the browser's own offset**, so a campaign approved to end on the 15th ran
 * through the 16th for every reader east of the offset it was created in. A campaign that runs a
 * day longer than the one that was approved is a financial defect, not a formatting one.
 *
 * ### The encoding, and why it is this one
 *
 * `tenant_campaigns.start_date`/`end_date` are `timestamptz`, and AGENT-PROTOCOL R1 forbids
 * changing a `reward_config` column's type — so "store it as a date" has to be expressed *within*
 * a `timestamptz`. The canonical, lossless encoding of a calendar date in an instant column is
 * **UTC midnight**: `2027-02-15` is stored as `2027-02-15 00:00:00+00`, which is what `psql`
 * shows, what {@link calendarDateOf} reads back with no arithmetic, and — unlike a `23:59:59`
 * "end of day" — has no offset in which it lands on a different day.
 *
 * **The end date is inclusive.** A campaign with `end_date = 2027-02-15` is live *through* the
 * 15th. Storing the last instant of that day instead would reintroduce exactly the stray
 * time-of-day this fix removes, so the inclusivity lives in the semantics (stated here, in
 * `campaign_config.v1.proto`, and in the shared schema) rather than in the stored number. Every
 * consumer must read it the same way; T-047's `.proto` says so in the field comment.
 *
 * ### Why this duplicates six lines of `packages/shared/src/campaign.schema.ts`
 *
 * The identical "what day does this value name" rule is needed by the wire *contract* (which runs
 * in the browser too) and by this write path. Exporting it once from `packages/shared` would need
 * a new name in `packages/shared/src/index.ts` — an explicit, named barrel that is another task's
 * owned file (R9), and one this task holds no grant for. The duplication is therefore deliberate
 * and disclosed in the T-065 completion report as a fold-in for whoever next owns that barrel;
 * `campaign-date.spec.ts` pins the two implementations to the same answers so a drift fails a
 * test rather than a campaign.
 */

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `campaign.schema.ts#isoDateTimeSchema`'s pattern — an instant with a **required** offset. A
 * bare `2027-02-15T00:00:00` is not one of the accepted forms and never becomes a day here: it is
 * ambiguous about which of two days it means, which is the whole ambiguity T-065 removes. */
const OFFSET_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The calendar day a campaign date names, in whichever form the wire delivered it.
 *
 * `2027-02-15` → itself. An instant carrying an offset → the day it names **in that offset**, so
 * `2027-02-15T23:59:59+05:30` is the 15th (what the maker picked) and not the 16th (what UTC
 * would have called it). Mirrors `campaign.schema.ts#calendarDayOf`; see this file's header.
 *
 * @throws RangeError for anything that is not an accepted form. Deliberately loud rather than
 * best-effort: every caller sits *behind* the validation that already rejected such a value with
 * a 400, so reaching the throw means a code path skipped the contract, and quietly inventing a
 * day for it would store a date nobody chose.
 */
export function toCalendarDate(value: string): string {
  if (CALENDAR_DATE_PATTERN.test(value)) {
    // `Date.parse` rolls `2027-02-30` silently forward into March, so a well-shaped day that does
    // not exist is caught by round-tripping it rather than by trusting the pattern.
    const parsed = Date.parse(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
      throw new RangeError(`not a campaign date: ${value}`);
    }
    return value;
  }

  const match = OFFSET_INSTANT_PATTERN.exec(value);
  const parsed = Date.parse(value);
  if (match === null || Number.isNaN(parsed)) {
    throw new RangeError(`not a campaign date: ${value}`);
  }
  return new Date(parsed + offsetMinutesOf(match[2]) * 60_000).toISOString().slice(0, 10);
}

/**
 * Whether `value` is one of the two forms a campaign date may arrive in — the back-end mirror of
 * `campaign.schema.ts#campaignDateSchema`, for callers that need the *question* answered rather
 * than the conversion performed (the agent's policy engine, which must refuse exactly what
 * `POST /campaigns` would refuse and no more).
 *
 * Defined in terms of {@link toCalendarDate} rather than repeating its checks, so the two can
 * never disagree about what is acceptable. A second list of patterns here would be a third
 * statement of the same rule, and the one that drifts is always the one nobody is looking at.
 */
export function isCampaignDate(value: string): boolean {
  try {
    toCalendarDate(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The value to store: UTC midnight of the day `value` names.
 *
 * The single write-side conversion. Everything that persists a campaign date goes through it, so
 * "what is in the column" has one answer rather than one per call site.
 */
export function toStoredCampaignDate(value: string): Date {
  return new Date(`${toCalendarDate(value)}T00:00:00.000Z`);
}

/**
 * The value to serve: the stored instant's calendar day.
 *
 * Deliberately UTC-based rather than locale-based. The stored value *is* UTC midnight, so this is
 * an exact read of the day that was written — and a server whose `TZ` happens to be
 * `Asia/Kolkata` must not serve a different date from one running in UTC, which is precisely what
 * a local-timezone read would do.
 *
 * Tolerant of a legacy row written before T-065 (one carrying a real time-of-day): such a row is
 * reported as its UTC day. That is the closest honest reading available and is why TC-8 of T-065
 * documents the backfill question explicitly rather than silently guessing an offset.
 */
export function calendarDateOf(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * `Z` → `0`, `+05:30` → `330`, `-05:00` → `-300`.
 *
 * Takes the **offset group** of {@link OFFSET_INSTANT_PATTERN}, not a whole timestamp, so it is
 * one of those two shapes by construction and has no failure case to invent a fallback for — a
 * fallback offset is how a date moves a day.
 */
function offsetMinutesOf(offset: string): number {
  if (offset === 'Z') return 0;
  const sign = offset.startsWith('-') ? -1 : 1;
  return sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
}
