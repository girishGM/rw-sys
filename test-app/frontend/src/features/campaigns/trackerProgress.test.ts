/**
 * T-008 — `deriveTrackerProgress`'s fallback math, exercised against all 3 real `completion_logic`
 * values (`all`/`any`/`n_of`) including the `n_of` case current demo data never actually reaches
 * (this task's implementation notes: "a tracker with `n_of` logic ... should render sensibly").
 */
import { describe, expect, it } from 'vitest';
import type { CampaignDetailComponent, CampaignDetailTracker } from '../../types';
import { deriveTrackerProgress } from './trackerProgress';

function component(overrides: Partial<CampaignDetailComponent>): CampaignDetailComponent {
  return {
    componentId: 1,
    componentCode: 'C1',
    componentName: 'Component',
    activityName: null,
    sequenceOrder: 1,
    isMandatory: true,
    completed: false,
    ...overrides,
  };
}

function tracker(overrides: Partial<CampaignDetailTracker>): CampaignDetailTracker {
  return {
    trackerId: 1,
    trackerCode: 'T1',
    trackerName: 'Tracker',
    description: null,
    completionLogic: 'all',
    completionThreshold: null,
    rewards: [],
    components: [],
    ...overrides,
  };
}

describe('deriveTrackerProgress', () => {
  it('is not complete under `all` logic when any component is incomplete', () => {
    const stats = deriveTrackerProgress(
      tracker({
        completionLogic: 'all',
        components: [component({ completed: true }), component({ completed: false })],
      }),
    );
    expect(stats).toEqual({ completedCount: 1, threshold: 2, completed: false });
  });

  it('is complete under `all` logic once every component is complete', () => {
    const stats = deriveTrackerProgress(
      tracker({
        completionLogic: 'all',
        components: [component({ completed: true }), component({ completed: true })],
      }),
    );
    expect(stats).toEqual({ completedCount: 2, threshold: 2, completed: true });
  });

  it('is complete under `any` logic once a single component is complete', () => {
    const stats = deriveTrackerProgress(
      tracker({
        completionLogic: 'any',
        components: [component({ completed: false }), component({ completed: true })],
      }),
    );
    expect(stats).toEqual({ completedCount: 1, threshold: 2, completed: true });
  });

  it('is complete under `n_of` logic once the real threshold is met, before every component is', () => {
    const stats = deriveTrackerProgress(
      tracker({
        completionLogic: 'n_of',
        completionThreshold: 2,
        components: [
          component({ completed: true }),
          component({ completed: true }),
          component({ completed: false }),
        ],
      }),
    );
    expect(stats).toEqual({ completedCount: 2, threshold: 2, completed: true });
  });

  it('is not complete under `n_of` logic below the real threshold', () => {
    const stats = deriveTrackerProgress(
      tracker({
        completionLogic: 'n_of',
        completionThreshold: 3,
        components: [component({ completed: true }), component({ completed: false })],
      }),
    );
    expect(stats).toEqual({ completedCount: 1, threshold: 3, completed: false });
  });

  it('is never complete with zero components, regardless of logic', () => {
    expect(
      deriveTrackerProgress(tracker({ completionLogic: 'all', components: [] })).completed,
    ).toBe(false);
  });
});
