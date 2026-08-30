/**
 * T-139 — the start/end dates T-051's campaign fixtures are written with.
 *
 * ### The defect this file closes
 *
 * `role-matrix.e2e-spec.ts` created its two fixture campaigns with
 * `VALUES (…, now(), now() + interval '30 days', …)`. `now()` is a wall-clock instant, so both rows
 * landed in `tenant_campaigns.start_date`/`end_date` carrying a time of day —
 * `2026-08-22 15:27:05.444+00`. The suite's `afterAll` does clean up (it sets `deleted_at`; it
 * cannot hard-delete, because `reward_app` holds no `DELETE` on `reward_config` — see that file's
 * `afterAll`), but a soft-deleted row is still a persisted row, so the two campaigns sat in the
 * shared development database for eight days and failed
 * `test/campaigns/t065-stored-dates.e2e-spec.ts`'s TC-4: *"no persisted campaign written by the
 * portal carries a time of day"*. T-113 reproduced that and filed T-139.
 *
 * The fix is not to add `T051_E2E_C_` to that scan's exclusion list — that list is a closed,
 * enumerated set of pre-T-065 legacy rows, and adding a *new* writer to it would turn a guard into
 * a blind spot (and edit another task's file). The fix is that this fixture writes what every other
 * campaign row in the database is required to contain.
 *
 * ### Why it calls the production converter instead of writing the SQL
 *
 * `toStoredCampaignDate()` is, per its own header, "the single write-side conversion — everything
 * that persists a campaign date goes through it, so *what is in the column* has one answer rather
 * than one per call site". A hand-written `date_trunc('day', now() AT TIME ZONE 'UTC')` would be a
 * second, independent statement of the same rule sitting in a test — and the copy nobody looks at
 * is the copy that drifts. Going through the real function means a fixture row is encoded by
 * exactly the code path a real `POST /campaigns` uses, so if that encoding ever changes, the
 * fixtures change with it.
 */
import { calendarDateOf, toStoredCampaignDate } from '@/modules/campaigns/campaign-date';

/** How long a fixture campaign runs — the `interval '30 days'` the original SQL used. */
const WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A campaign's stored window: two `timestamptz` values, both exactly UTC midnight. */
export interface FixtureCampaignWindow {
  readonly start: Date;
  readonly end: Date;
}

/**
 * Today, and today + 30 days, in the encoding `tenant_campaigns` is required to hold: UTC midnight
 * of a calendar day (T-065).
 *
 * Both ends go through {@link toStoredCampaignDate}; the end is not computed by adding 30 days to
 * the *stored* start and trusting the arithmetic, but by naming the calendar day 30 days out and
 * converting that day the same way the start was converted. The two happen to agree in UTC — UTC
 * has no DST — and doing it this way means they would still agree if the encoding ever stopped
 * being UTC midnight.
 *
 * @param now injectable so a test can pin a day; defaults to the real clock, which is what the
 * fixture uses.
 */
export function fixtureCampaignWindow(now: Date = new Date()): FixtureCampaignWindow {
  const startDay = calendarDateOf(now);
  const start = toStoredCampaignDate(startDay);
  const end = toStoredCampaignDate(
    calendarDateOf(new Date(start.getTime() + WINDOW_DAYS * DAY_MS)),
  );
  return { start, end };
}
