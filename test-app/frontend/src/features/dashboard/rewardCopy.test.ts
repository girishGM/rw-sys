/**
 * T-007 — `formatRewardCopy` turns a real `RewardAssignment` into the display string the
 * trackers widget's motivational copy is built from (`UI-UX-DESIGN.md` "Content rules": `$`
 * prefix, two decimal places for cashback).
 */
import { describe, expect, it } from 'vitest';
import type { RewardAssignment } from '../../types';
import { formatRewardCopy } from './rewardCopy';

function reward(overrides: Partial<RewardAssignment>): RewardAssignment {
  return {
    id: 1,
    level: 'tracker',
    refId: 1,
    rewardPolicyId: 1,
    rewardPolicyName: 'policy',
    rewardId: 1,
    rewardName: 'Some Reward',
    unitType: null,
    unitCode: null,
    amount: null,
    status: 'active',
    ...overrides,
  };
}

describe('formatRewardCopy', () => {
  it('formats a currency reward as "$X.XX cashback"', () => {
    expect(formatRewardCopy(reward({ unitType: 'currency', amount: '20' }))).toBe(
      '$20.00 cashback',
    );
  });

  it('formats a currency reward with existing decimals to exactly 2 places', () => {
    expect(formatRewardCopy(reward({ unitType: 'currency', amount: '15.5' }))).toBe(
      '$15.50 cashback',
    );
  });

  it('formats a voucher reward generically, since the real code is not issued yet', () => {
    expect(formatRewardCopy(reward({ unitType: 'voucher', amount: null }))).toBe('a promo code');
  });

  it('formats a points reward as "N points"', () => {
    expect(formatRewardCopy(reward({ unitType: 'points', amount: '500' }))).toBe('500 points');
  });

  it('never fabricates "$0.00 cashback" for a real reward with no fixed amount — uses its name instead', () => {
    expect(
      formatRewardCopy(
        reward({ unitType: 'currency', amount: null, rewardName: 'Signup Cashback' }),
      ),
    ).toBe('Signup Cashback cashback');
  });

  it('never fabricates "0 points" for a real points reward with no fixed amount — uses its name instead', () => {
    expect(
      formatRewardCopy(reward({ unitType: 'points', amount: null, rewardName: 'Loyalty Points' })),
    ).toBe('Loyalty Points points');
  });

  it('falls back to the reward name for an unrecognised unitType', () => {
    expect(formatRewardCopy(reward({ unitType: 'mystery', rewardName: 'Mystery Prize' }))).toBe(
      'Mystery Prize',
    );
  });
});
