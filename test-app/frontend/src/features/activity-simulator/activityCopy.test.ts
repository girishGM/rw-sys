import { describe, expect, it } from 'vitest';
import { progressDeltaLabel, rewardBadgeLabel } from './activityCopy';
import type { ProgressDelta, RewardLedgerEntry } from '../../types';

function delta(overrides: Partial<ProgressDelta> = {}): ProgressDelta {
  return {
    campaignId: 1,
    campaignCode: 'SUMMER_CASHBACK_SPRINT',
    campaignName: 'Summer Cashback Sprint',
    trackerId: 10,
    trackerCode: 'SCS_TRACKER',
    trackerName: 'Grocery Streak',
    componentId: 100,
    completedCount: 4,
    threshold: 5,
    trackerCompleted: false,
    ...overrides,
  };
}

function reward(overrides: Partial<RewardLedgerEntry> = {}): RewardLedgerEntry {
  return {
    id: 'r1',
    customerId: 'priya-shah',
    campaignId: 1,
    campaignCode: 'SUMMER_CASHBACK_SPRINT',
    type: 'cashback',
    value: '20',
    currency: 'USD',
    status: 'unused',
    issuedAt: '2026-06-01T00:00:00.000Z',
    expiresAt: null,
    ...overrides,
  };
}

describe('progressDeltaLabel', () => {
  it('shows a plain "N of M" for an in-progress tracker', () => {
    expect(progressDeltaLabel(delta())).toBe('Grocery Streak: 4 of 5');
  });

  it('flags a tracker completed by this exact activity', () => {
    expect(progressDeltaLabel(delta({ completedCount: 5, trackerCompleted: true }))).toBe(
      'Grocery Streak: 5 of 5 — complete!',
    );
  });
});

describe('rewardBadgeLabel', () => {
  it('formats cashback as a real $ value, 2 decimal places', () => {
    expect(rewardBadgeLabel(reward({ type: 'cashback', value: '20' }))).toBe('$20.00 cashback');
  });

  it('falls back to the raw value verbatim if it is ever non-numeric', () => {
    expect(rewardBadgeLabel(reward({ type: 'cashback', value: 'n/a' }))).toBe('n/a cashback');
  });

  it('formats points', () => {
    expect(rewardBadgeLabel(reward({ type: 'points', value: '150' }))).toBe('150 points');
  });

  it('formats a promo code', () => {
    expect(rewardBadgeLabel(reward({ type: 'promo_code', value: 'SAVE20' }))).toBe(
      'Promo code SAVE20',
    );
  });
});
