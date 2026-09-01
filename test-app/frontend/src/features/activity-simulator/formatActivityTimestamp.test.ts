import { describe, expect, it } from 'vitest';
import { formatActivityTimestamp } from './formatActivityTimestamp';

describe('formatActivityTimestamp', () => {
  it('formats a real ISO instant in UTC, independent of the host timezone', () => {
    expect(formatActivityTimestamp('2026-06-01T14:32:00.000Z')).toBe('Jun 1, 2:32 PM');
  });

  it('pads single-digit minutes', () => {
    expect(formatActivityTimestamp('2026-01-05T09:05:00.000Z')).toBe('Jan 5, 9:05 AM');
  });
});
