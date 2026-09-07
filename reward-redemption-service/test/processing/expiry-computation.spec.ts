/**
 * T-RR-063 — `computeExpiresAt`. A pure function; no DB, no clock mock beyond passing `nowUtc` in
 * directly (this task's own file header).
 */
import { computeExpiresAt } from '@/modules/processing/expiry-computation';

describe('T-RR-063 — computeExpiresAt', () => {
  // TC-1.
  it('TC-1: computeExpiresAt(now, 15, "minutes") = now + 15 min, exact', () => {
    const now = new Date('2026-06-15T10:00:00.000Z');

    const result = computeExpiresAt(now, 15, 'minutes');

    expect(result).toEqual(new Date('2026-06-15T10:15:00.000Z'));
  });

  // TC-2.
  it('TC-2: computeExpiresAt(now, 10, "days") = now + 10 days, exact, using UTC arithmetic, not local calendar days (correct across DST)', () => {
    // A `now` that falls inside a US DST transition window (spring-forward, 2027-03-14 in
    // America/New_York) — a local-calendar-day implementation would drift by an hour across it;
    // pure UTC millisecond arithmetic never does.
    const now = new Date('2027-03-10T00:00:00.000Z');

    const result = computeExpiresAt(now, 10, 'days');

    expect(result).toEqual(new Date(now.getTime() + 10 * 86_400_000));
    expect(result).toEqual(new Date('2027-03-20T00:00:00.000Z'));
  });

  // TC-3.
  it('TC-3: computeExpiresAt(now, null, null) = null -- never expires', () => {
    const now = new Date('2026-06-15T10:00:00.000Z');

    expect(computeExpiresAt(now, null, null)).toBeNull();
  });

  it('computeExpiresAt(now, 5, "hours") = now + 5 hours, exact', () => {
    const now = new Date('2026-06-15T10:00:00.000Z');

    const result = computeExpiresAt(now, 5, 'hours');

    expect(result).toEqual(new Date('2026-06-15T15:00:00.000Z'));
  });

  it('rejects (throws) an expiryUnit outside the three known values, rather than guessing', () => {
    const now = new Date('2026-06-15T10:00:00.000Z');

    expect(() =>
      // A stale cached config value newer than this deployed build recognizes -- deliberately
      // cast past the compile-time union (implementation note 2's own "must not guess").
      computeExpiresAt(now, 1, 'weeks' as unknown as 'minutes' | 'hours' | 'days'),
    ).toThrow(/unknown expiryUnit/);
  });

  it('does not mutate the nowUtc Date instance passed in', () => {
    const now = new Date('2026-06-15T10:00:00.000Z');
    const originalTime = now.getTime();

    computeExpiresAt(now, 15, 'minutes');

    expect(now.getTime()).toBe(originalTime);
  });
});
