import { describe, expect, it } from 'vitest';
import { rewardTypeLabel, rewardTypeNounPlural, rewardValueLabel } from './rewardCopy';
import type { RewardLedgerEntry } from '../../types';

function reward(overrides: Partial<RewardLedgerEntry>): RewardLedgerEntry {
  return {
    id: 'r1',
    customerId: 'priya-shah',
    campaignId: 1,
    campaignCode: 'SUMMER_CASHBACK_SPRINT',
    type: 'cashback',
    value: '25',
    currency: 'USD',
    status: 'unused',
    issuedAt: '2026-06-05T00:00:00.000Z',
    expiresAt: '2026-08-31',
    ...overrides,
  };
}

describe('rewardTypeLabel', () => {
  it("matches ARCHITECTURE.md §4's exact 3 group names", () => {
    expect(rewardTypeLabel('cashback')).toBe('Cashback');
    expect(rewardTypeLabel('promo_code')).toBe('Promo Code');
    expect(rewardTypeLabel('points')).toBe('Stripe Points');
  });
});

describe('rewardTypeNounPlural', () => {
  it("gives lowercase empty-state nouns, matching the task file's own example", () => {
    expect(rewardTypeNounPlural('promo_code')).toBe('promo codes');
  });
});

describe('rewardValueLabel', () => {
  it('formats cashback with a $ prefix and 2 decimal places', () => {
    expect(rewardValueLabel(reward({ type: 'cashback', value: '25' }))).toBe('$25.00');
    expect(rewardValueLabel(reward({ type: 'cashback', value: '25.5' }))).toBe('$25.50');
  });

  it('falls back to the raw value if a cashback value is somehow non-numeric', () => {
    expect(rewardValueLabel(reward({ type: 'cashback', value: 'n/a' }))).toBe('n/a');
  });

  it('formats points with a "pts" suffix', () => {
    expect(rewardValueLabel(reward({ type: 'points', value: '500', currency: null }))).toBe(
      '500 pts',
    );
  });

  it('shows the promo code value verbatim', () => {
    expect(rewardValueLabel(reward({ type: 'promo_code', value: 'SAVE20', currency: null }))).toBe(
      'SAVE20',
    );
  });
});
