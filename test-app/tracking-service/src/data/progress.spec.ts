import {
  ProgressStore,
  completedComponentCount,
  isTrackerComplete,
  trackerThreshold,
  type CampaignProgress,
  type TrackerProgress,
} from './progress';

function tracker(overrides: Partial<TrackerProgress> = {}): TrackerProgress {
  return {
    trackerId: 7,
    trackerCode: 'TRK',
    trackerName: 'Tracker',
    completionLogic: 'n_of',
    completionThreshold: 5,
    components: [
      { componentId: 1, componentCode: 'C1', componentName: 'C1', completed: true },
      { componentId: 2, componentCode: 'C2', componentName: 'C2', completed: true },
      { componentId: 3, componentCode: 'C3', componentName: 'C3', completed: true },
      { componentId: 4, componentCode: 'C4', componentName: 'C4', completed: false },
      { componentId: 5, componentCode: 'C5', componentName: 'C5', completed: false },
    ],
    ...overrides,
  };
}

describe('completedComponentCount / trackerThreshold', () => {
  it('counts completed components and uses completionThreshold as the denominator for n_of', () => {
    const t = tracker();
    expect(completedComponentCount(t)).toBe(3);
    expect(trackerThreshold(t)).toBe(5);
  });

  it('falls back to component count as the denominator when completionThreshold is null (all/any)', () => {
    const t = tracker({
      completionLogic: 'all',
      completionThreshold: null,
      components: [
        { componentId: 1, componentCode: 'C1', componentName: 'C1', completed: true },
        { componentId: 2, componentCode: 'C2', componentName: 'C2', completed: true },
      ],
    });
    expect(trackerThreshold(t)).toBe(2);
  });
});

describe('isTrackerComplete', () => {
  it('n_of: complete once completed >= threshold', () => {
    expect(isTrackerComplete(tracker())).toBe(false); // 3/5
    expect(isTrackerComplete(tracker({ completionThreshold: 3 }))).toBe(true); // 3/3
  });

  it('all: complete only when every component is complete', () => {
    const twoOfTwo = tracker({
      completionLogic: 'all',
      completionThreshold: null,
      components: [
        { componentId: 1, componentCode: 'C1', componentName: 'C1', completed: true },
        { componentId: 2, componentCode: 'C2', componentName: 'C2', completed: true },
      ],
    });
    expect(isTrackerComplete(twoOfTwo)).toBe(true);

    const oneOfTwo = {
      ...twoOfTwo,
      components: [twoOfTwo.components[0], { ...twoOfTwo.components[1], completed: false }],
    };
    expect(isTrackerComplete(oneOfTwo)).toBe(false);
  });

  it('any: complete once at least one component is complete', () => {
    const t = tracker({
      completionLogic: 'any',
      completionThreshold: null,
      components: [
        { componentId: 1, componentCode: 'C1', componentName: 'C1', completed: false },
        { componentId: 2, componentCode: 'C2', componentName: 'C2', completed: true },
      ],
    });
    expect(isTrackerComplete(t)).toBe(true);
  });

  it('a tracker with zero components is never complete', () => {
    expect(isTrackerComplete(tracker({ components: [] }))).toBe(false);
  });
});

describe('ProgressStore', () => {
  const campaign: CampaignProgress = {
    campaignId: 42,
    campaignCode: 'SUMMER_CASHBACK_SPRINT',
    campaignName: 'Summer Cashback Sprint',
    trackers: [tracker()],
  };

  it('TC-7/TC-8: getForCustomer returns [] for an unknown customer, real data once seeded', () => {
    const store = new ProgressStore();
    expect(store.getForCustomer('nobody')).toEqual([]);

    store.setForCustomer('priya-shah', [campaign]);
    expect(store.getForCustomer('priya-shah')).toEqual([campaign]);
  });

  it('setComponentCompletion updates one component without mutating the original object', () => {
    const store = new ProgressStore();
    store.setForCustomer('priya-shah', [campaign]);

    const updated = store.setComponentCompletion('priya-shah', 42, 7, 4, true);

    expect(updated?.components.find((c) => c.componentId === 4)?.completed).toBe(true);
    // the original campaign object passed to setForCustomer is untouched (immutable update)
    expect(campaign.trackers[0].components.find((c) => c.componentId === 4)?.completed).toBe(false);
    expect(
      store.getForCustomer('priya-shah')[0].trackers[0].components.find((c) => c.componentId === 4)
        ?.completed,
    ).toBe(true);
  });

  it('setComponentCompletion returns null for an unknown customer/campaign/tracker/component', () => {
    const store = new ProgressStore();
    store.setForCustomer('priya-shah', [campaign]);

    expect(store.setComponentCompletion('nobody', 42, 7, 4, true)).toBeNull();
    expect(store.setComponentCompletion('priya-shah', 999, 7, 4, true)).toBeNull();
    expect(store.setComponentCompletion('priya-shah', 42, 999, 4, true)).toBeNull();
  });
});
