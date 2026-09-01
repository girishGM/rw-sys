/**
 * T-007 — `UI-UX-DESIGN.md` "Content rules": `"Mon D – Mon D, YYYY"` campaign date range format.
 */
import { describe, expect, it } from 'vitest';
import { formatDateRange } from './formatDateRange';

describe('formatDateRange', () => {
  it('formats a same-year range with the year shown once, at the end', () => {
    expect(formatDateRange('2026-06-01', '2026-08-31')).toBe('Jun 1 – Aug 31, 2026');
  });

  it('formats a cross-year range with the year shown on both ends', () => {
    expect(formatDateRange('2026-12-15', '2027-01-05')).toBe('Dec 15, 2026 – Jan 5, 2027');
  });

  it('is not shifted a day earlier/later by the local timezone (dates are UTC-anchored)', () => {
    // A regression guard for the classic `new Date('YYYY-MM-DD')` + local-timezone formatting
    // bug: Jan 1 must stay Jan 1, not roll back to Dec 31 in a timezone behind UTC.
    expect(formatDateRange('2026-01-01', '2026-12-31')).toBe('Jan 1 – Dec 31, 2026');
  });
});
