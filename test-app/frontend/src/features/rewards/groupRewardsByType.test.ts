import { describe, expect, it } from 'vitest';
import { groupRewardsByType } from './groupRewardsByType';
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

describe('groupRewardsByType', () => {
  it('buckets rewards by their real type', () => {
    const rewards = [
      reward({ id: 'a', type: 'cashback' }),
      reward({ id: 'b', type: 'promo_code' }),
      reward({ id: 'c', type: 'cashback' }),
    ];

    const grouped = groupRewardsByType(rewards);

    expect(grouped.cashback.map((r) => r.id)).toEqual(['a', 'c']);
    expect(grouped.promo_code.map((r) => r.id)).toEqual(['b']);
    expect(grouped.points).toEqual([]);
  });

  it('returns every type as an empty array, never a missing key, for a customer with zero rewards', () => {
    const grouped = groupRewardsByType([]);

    expect(grouped.cashback).toEqual([]);
    expect(grouped.promo_code).toEqual([]);
    expect(grouped.points).toEqual([]);
  });
});
