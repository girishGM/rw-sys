import {
  evaluateTrackerActivity,
  findComponentToComplete,
  type EvaluableTracker,
} from './evaluate';

function allTracker(overrides: Partial<EvaluableTracker> = {}): EvaluableTracker {
  return {
    trackerId: 2001,
    trackerCode: 'ALL_TRACKER',
    trackerName: 'All Tracker',
    completionLogic: 'all',
    completionThreshold: null,
    components: [
      {
        componentId: 3001,
        componentCode: 'COMP_A',
        componentName: 'Component A',
        completed: false,
        activityId: 501,
        activityName: 'Grocery Purchase',
      },
      {
        componentId: 3002,
        componentCode: 'COMP_B',
        componentName: 'Component B',
        completed: false,
        activityId: 502,
        activityName: 'Weekend Transaction',
      },
    ],
    ...overrides,
  };
}

function nOfTracker(overrides: Partial<EvaluableTracker> = {}): EvaluableTracker {
  return {
    trackerId: 2002,
    trackerCode: 'NOF_TRACKER',
    trackerName: 'N-of Tracker',
    completionLogic: 'n_of',
    completionThreshold: 2,
    components: [
      {
        componentId: 3003,
        componentCode: 'COMP_C1',
        componentName: 'Component C1',
        completed: false,
        activityId: 503,
        activityName: 'Refer a Friend',
      },
      {
        componentId: 3004,
        componentCode: 'COMP_C2',
        componentName: 'Component C2',
        completed: false,
        activityId: 503,
        activityName: 'Refer a Friend',
      },
      {
        componentId: 3005,
        componentCode: 'COMP_C3',
        componentName: 'Component C3',
        completed: false,
        activityId: 503,
        activityName: 'Refer a Friend',
      },
    ],
    ...overrides,
  };
}

describe('findComponentToComplete', () => {
  it('matches the first not-yet-completed component whose activityName equals activityType, case/whitespace-insensitively', () => {
    const tracker = allTracker();
    expect(findComponentToComplete(tracker, '  grocery PURCHASE  ')?.componentId).toBe(3001);
  });

  it('returns null when nothing matches (TC-12: a legitimate no-op)', () => {
    expect(findComponentToComplete(allTracker(), 'Nonexistent Activity Type')).toBeNull();
  });

  it('returns null for a blank activityType', () => {
    expect(findComponentToComplete(allTracker(), '   ')).toBeNull();
  });

  it('never matches an already-completed component', () => {
    const tracker = allTracker({
      components: [{ ...allTracker().components[0], completed: true }, allTracker().components[1]],
    });
    expect(findComponentToComplete(tracker, 'Grocery Purchase')).toBeNull();
  });

  it('picks the first eligible match, in stored order, when several components share an activityName', () => {
    const tracker = nOfTracker();
    expect(findComponentToComplete(tracker, 'Refer a Friend')?.componentId).toBe(3003);
  });
});

describe('evaluateTrackerActivity — completion_logic: all (TC-7)', () => {
  it('does not complete after only one of two components (TC-5)', () => {
    const result = evaluateTrackerActivity(allTracker(), 'Grocery Purchase');

    expect(result.matchedComponentId).toBe(3001);
    expect(result.wasComplete).toBe(false);
    expect(result.isNowComplete).toBe(false);
    expect(result.justCompleted).toBe(false);
  });

  it('completes only once BOTH components are done, not after just one (TC-6/TC-7)', () => {
    const afterFirst = evaluateTrackerActivity(allTracker(), 'Grocery Purchase');
    const afterSecond = evaluateTrackerActivity(afterFirst.updatedTracker, 'Weekend Transaction');

    expect(afterSecond.matchedComponentId).toBe(3002);
    expect(afterSecond.wasComplete).toBe(false);
    expect(afterSecond.isNowComplete).toBe(true);
    expect(afterSecond.justCompleted).toBe(true);
  });
});

describe('evaluateTrackerActivity — completion_logic: n_of (TC-8)', () => {
  it('does not complete below threshold', () => {
    const afterFirst = evaluateTrackerActivity(nOfTracker(), 'Refer a Friend');
    expect(afterFirst.isNowComplete).toBe(false);
    expect(afterFirst.justCompleted).toBe(false);
  });

  it('completes once the threshold count of components is complete, per its real completionThreshold', () => {
    const afterFirst = evaluateTrackerActivity(nOfTracker(), 'Refer a Friend');
    const afterSecond = evaluateTrackerActivity(afterFirst.updatedTracker, 'Refer a Friend');

    expect(afterSecond.matchedComponentId).toBe(3004);
    expect(afterSecond.isNowComplete).toBe(true);
    expect(afterSecond.justCompleted).toBe(true);
  });

  it('does not fire justCompleted again for a 3rd matching activity once threshold is already met (no double award)', () => {
    const afterFirst = evaluateTrackerActivity(nOfTracker(), 'Refer a Friend');
    const afterSecond = evaluateTrackerActivity(afterFirst.updatedTracker, 'Refer a Friend');
    const afterThird = evaluateTrackerActivity(afterSecond.updatedTracker, 'Refer a Friend');

    expect(afterThird.matchedComponentId).toBe(3005);
    expect(afterThird.wasComplete).toBe(true);
    expect(afterThird.isNowComplete).toBe(true);
    expect(afterThird.justCompleted).toBe(false);
  });
});

describe('evaluateTrackerActivity — no match (TC-12)', () => {
  it('leaves the tracker untouched and reports no completion', () => {
    const tracker = allTracker();
    const result = evaluateTrackerActivity(tracker, 'Nonexistent Activity Type');

    expect(result.matchedComponentId).toBeNull();
    expect(result.updatedTracker).toEqual(tracker);
    expect(result.justCompleted).toBe(false);
  });
});
