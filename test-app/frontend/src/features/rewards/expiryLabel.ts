/**
 * T-009 — the expiry countdown badge's copy (this task's Scope: "expiry countdown badge on
 * anything unused and within the expiring-soon window from T-007"). *Whether* a reward is
 * "expiring soon" at all is never recomputed here — `RewardsPage` reads the exact same
 * `dashboardSummary.expiringSoon` set `tracking-service`'s `routes/dashboard.ts` already computed
 * (its own 7-day window constant) via `useDashboard`, so this page's badge and T-007's dashboard
 * banner can never drift onto two different thresholds/counts for the same customer. This module
 * only turns an already-known-to-be-expiring-soon reward's real `expiresAt` into the badge's
 * *display text* ("Expires in 3 days").
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Normalises to UTC midnight so "days remaining" is a genuine calendar-day count rather than a
 * raw millisecond division that would, e.g., call something expiring in 6 hours "1 day" even
 * though it expires later *today* — `expiresAt` values in this app are always date-only
 * (`campaign.endDate`, `YYYY-MM-DD`, parsed as UTC midnight per `formatDateRange.ts`'s own
 * precedent in `features/campaigns`/`features/dashboard`), so comparing at UTC-midnight
 * granularity matches how that date was authored. */
function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** `now` is injectable so this stays deterministic in tests rather than depending on wall-clock
 * time at test-run time. */
export function expiryCountdownLabel(
  expiresAt: string,
  now: () => Date = () => new Date(),
): string {
  const daysRemaining = Math.round(
    (startOfUtcDay(new Date(expiresAt)) - startOfUtcDay(now())) / MS_PER_DAY,
  );

  if (daysRemaining <= 0) return 'Expires today';
  if (daysRemaining === 1) return 'Expires in 1 day';
  return `Expires in ${daysRemaining} days`;
}
