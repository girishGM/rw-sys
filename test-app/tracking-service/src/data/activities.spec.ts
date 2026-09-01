import { ActivityHistoryStore, describeActivity, type ActivityHistoryEntry } from './activities';
import type { RewardLedgerEntry } from './rewards';

const promoReward: RewardLedgerEntry = {
  id: 'reward-1',
  customerId: 'priya-shah',
  campaignId: 1001,
  campaignCode: 'FIXTURE_ALL',
  type: 'promo_code',
  value: 'SAVE20',
  currency: null,
  status: 'unused',
  issuedAt: '2026-08-15',
  expiresAt: '2026-09-15',
};

describe('describeActivity', () => {
  it('describes a reward-earning activity, naming the reward type(s)', () => {
    expect(describeActivity('Grocery Purchase', true, [promoReward])).toBe(
      'Grocery Purchase — reward earned (promo_code)',
    );
  });

  it('describes a matched-but-not-completing activity', () => {
    expect(describeActivity('Grocery Purchase', true, [])).toBe(
      'Grocery Purchase — progress updated',
    );
  });

  it('describes an activity that matched no tracker component', () => {
    expect(describeActivity('Unrelated Activity', false, [])).toBe(
      'Unrelated Activity — no matching tracker',
    );
  });
});

describe('ActivityHistoryStore', () => {
  function entry(overrides: Partial<ActivityHistoryEntry> = {}): ActivityHistoryEntry {
    return {
      id: 'activity-1',
      customerId: 'priya-shah',
      timestamp: '2026-09-01T00:00:00.000Z',
      activityType: 'Grocery Purchase',
      merchant: null,
      amount: null,
      description: 'Grocery Purchase — progress updated',
      matched: true,
      progress: [],
      rewards: [],
      ...overrides,
    };
  }

  it('TC-1 (unfixed baseline): getForCustomer returns [] until an entry is added, same as RewardsStore', () => {
    const store = new ActivityHistoryStore();
    expect(store.getForCustomer('priya-shah')).toEqual([]);
  });

  it('TC-2: addEntry makes the entry retrievable for that customer', () => {
    const store = new ActivityHistoryStore();
    store.addEntry(entry());
    expect(store.getForCustomer('priya-shah')).toEqual([entry()]);
  });

  it('TC-3 (regression): returns entries most-recent-first, not insertion order', () => {
    const store = new ActivityHistoryStore();
    store.addEntry(entry({ id: 'first', timestamp: '2026-09-01T00:00:00.000Z' }));
    store.addEntry(entry({ id: 'second', timestamp: '2026-09-01T00:05:00.000Z' }));
    store.addEntry(entry({ id: 'third', timestamp: '2026-09-01T00:10:00.000Z' }));

    expect(store.getForCustomer('priya-shah').map((e) => e.id)).toEqual([
      'third',
      'second',
      'first',
    ]);
  });

  it('TC-4: does not leak one customer’s history to another', () => {
    const store = new ActivityHistoryStore();
    store.addEntry(entry());
    expect(store.getForCustomer('marcus-tan')).toEqual([]);
  });
});
