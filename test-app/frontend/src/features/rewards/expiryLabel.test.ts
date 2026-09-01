import { describe, expect, it } from 'vitest';
import { expiryCountdownLabel } from './expiryLabel';

const NOW = () => new Date('2026-08-25T00:00:00.000Z');

describe('expiryCountdownLabel', () => {
  it('pluralises days remaining', () => {
    expect(expiryCountdownLabel('2026-08-28T00:00:00.000Z', NOW)).toBe('Expires in 3 days');
  });

  it('says "1 day" (not "1 days") when exactly one full day remains', () => {
    expect(expiryCountdownLabel('2026-08-26T00:00:00.000Z', NOW)).toBe('Expires in 1 day');
  });

  it('says "Expires today" for anything expiring within the current day', () => {
    expect(expiryCountdownLabel('2026-08-25T06:00:00.000Z', NOW)).toBe('Expires today');
  });

  it('says "Expires today" rather than a negative count for something already past expiry', () => {
    expect(expiryCountdownLabel('2026-08-20T00:00:00.000Z', NOW)).toBe('Expires today');
  });
});
