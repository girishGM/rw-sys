import { RewardsStore, rewardTypeFromUnitType, type RewardLedgerEntry } from './rewards';

describe('rewardTypeFromUnitType', () => {
  it('maps the 3 real unitType values to this app’s reward kinds', () => {
    expect(rewardTypeFromUnitType('currency')).toBe('cashback');
    expect(rewardTypeFromUnitType('voucher')).toBe('promo_code');
    expect(rewardTypeFromUnitType('points')).toBe('points');
  });

  it('throws on an unrecognised unitType rather than guessing', () => {
    expect(() => rewardTypeFromUnitType('bogus')).toThrow(/unrecognised unitType/);
    expect(() => rewardTypeFromUnitType(null)).toThrow(/unrecognised unitType/);
  });
});

describe('RewardsStore', () => {
  const save20: RewardLedgerEntry = {
    id: 'seed-priya-shah-save20',
    customerId: 'priya-shah',
    campaignId: 529444,
    campaignCode: 'WEEKEND_PROMO_BLITZ',
    type: 'promo_code',
    value: 'SAVE20',
    currency: null,
    status: 'unused',
    issuedAt: '2026-08-15',
    expiresAt: '2026-09-15',
  };

  it('TC-7: getForCustomer returns [] until seeded, then the real seeded entry', () => {
    const store = new RewardsStore();
    expect(store.getForCustomer('priya-shah')).toEqual([]);

    store.addReward(save20);
    expect(store.getForCustomer('priya-shah')).toEqual([save20]);
  });

  it('does not leak one customer’s rewards to another', () => {
    const store = new RewardsStore();
    store.addReward(save20);
    expect(store.getForCustomer('marcus-tan')).toEqual([]);
  });

  it('markUsed flips status without touching other entries', () => {
    const store = new RewardsStore();
    store.addReward(save20);
    store.addReward({ ...save20, id: 'another-reward' });

    const updated = store.markUsed('priya-shah', 'seed-priya-shah-save20');

    expect(updated?.status).toBe('used');
    const all = store.getForCustomer('priya-shah');
    expect(all.find((r) => r.id === 'seed-priya-shah-save20')?.status).toBe('used');
    expect(all.find((r) => r.id === 'another-reward')?.status).toBe('unused');
  });

  it('markUsed returns null for an unknown customer or reward id', () => {
    const store = new RewardsStore();
    store.addReward(save20);
    expect(store.markUsed('nobody', 'seed-priya-shah-save20')).toBeNull();
    expect(store.markUsed('priya-shah', 'no-such-reward')).toBeNull();
  });
});
