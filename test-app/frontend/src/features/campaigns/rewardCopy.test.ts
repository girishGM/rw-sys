/**
 * T-008 — `rewardTypeLabel`/`rewardValueLabel` build the Reward card's own type + value strings
 * from a real `RewardAssignment`, never fabricating a number the real config didn't set.
 */
import { describe, expect, it } from 'vitest';
import type { RewardAssignment } from '../../types';
import { rewardTypeLabel, rewardValueLabel } from './rewardCopy';

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

describe('rewardTypeLabel', () => {
  it('labels a currency reward "Cashback"', () => {
    expect(rewardTypeLabel(reward({ unitType: 'currency' }))).toBe('Cashback');
  });

  it('labels a voucher reward "Promo Code"', () => {
    expect(rewardTypeLabel(reward({ unitType: 'voucher' }))).toBe('Promo Code');
  });

  it('labels a points reward "Stripe Points"', () => {
    expect(rewardTypeLabel(reward({ unitType: 'points' }))).toBe('Stripe Points');
  });

  it('falls back to the reward name for an unrecognised unitType', () => {
    expect(rewardTypeLabel(reward({ unitType: 'mystery', rewardName: 'Mystery Prize' }))).toBe(
      'Mystery Prize',
    );
  });
});

describe('rewardValueLabel', () => {
  it('formats a currency reward as "$X.XX"', () => {
    expect(rewardValueLabel(reward({ unitType: 'currency', amount: '20' }))).toBe('$20.00');
  });

  it('formats a currency reward with existing decimals to exactly 2 places', () => {
    expect(rewardValueLabel(reward({ unitType: 'currency', amount: '15.5' }))).toBe('$15.50');
  });

  it('never fabricates "$0.00" for a real reward with no fixed amount — uses its name instead', () => {
    expect(
      rewardValueLabel(
        reward({ unitType: 'currency', amount: null, rewardName: 'Signup Cashback' }),
      ),
    ).toBe('Signup Cashback');
  });

  it('shows the policy name for a voucher, since the real code is not issued at this level', () => {
    expect(rewardValueLabel(reward({ unitType: 'voucher', rewardName: 'Save 20%' }))).toBe(
      'Save 20%',
    );
  });

  it('formats a points reward as "N pts"', () => {
    expect(rewardValueLabel(reward({ unitType: 'points', amount: '500' }))).toBe('500 pts');
  });

  it('never fabricates "0 pts" for a real points reward with no fixed amount — uses its name instead', () => {
    expect(
      rewardValueLabel(reward({ unitType: 'points', amount: null, rewardName: 'Loyalty Points' })),
    ).toBe('Loyalty Points');
  });

  it('falls back to the reward name for an unrecognised unitType', () => {
    expect(rewardValueLabel(reward({ unitType: 'mystery', rewardName: 'Mystery Prize' }))).toBe(
      'Mystery Prize',
    );
  });
});
