/**
 * T-008 — `campaignStatusTone` maps every real campaign status this app can receive to a `Badge`
 * tone (TC-1's "correct status badges").
 */
import { describe, expect, it } from 'vitest';
import { campaignStatusTone } from './campaignStatus';

describe('campaignStatusTone', () => {
  it('reads `active` as the accent tone', () => {
    expect(campaignStatusTone('active')).toBe('accent');
  });

  it('reads `paused` as the warn tone (needs attention)', () => {
    expect(campaignStatusTone('paused')).toBe('warn');
  });

  it('reads `completed` as the muted tone', () => {
    expect(campaignStatusTone('completed')).toBe('muted');
  });

  it('falls back to muted for any unrecognised status rather than crashing', () => {
    expect(campaignStatusTone('archived')).toBe('muted');
  });
});
