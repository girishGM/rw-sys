/**
 * T-010 — feed timestamps. Formatted in UTC (like `features/dashboard/formatDateRange.ts`'s own
 * precedent) so this stays deterministic in tests regardless of the machine's local timezone —
 * `ActivityHistoryEntry.timestamp` is a real ISO 8601 instant (`new Date().toISOString()`,
 * `tracking-service`'s `routes/activities.ts`), not a date-only string, but UTC display avoids the
 * same "shifts by a timezone" risk that module's own header calls out for date-only values.
 */
const FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});

export function formatActivityTimestamp(iso: string): string {
  return FORMATTER.format(new Date(iso));
}
