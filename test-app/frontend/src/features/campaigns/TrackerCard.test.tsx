/**
 * T-INT-055 — `TrackerCard`'s own three render states (real progress / progress-unavailable /
 * completed), the same three-outcome contract `TrackerRow` already has on the Dashboard
 * (T-INT-021): TC-1 (real numbers), TC-2 (`progressUnknown` never renders as a fake `0`), TC-3 (a
 * tracker whose threshold is met shows "Complete"/"Earned", matching RAP's own `completed` flag).
 * Also covers the `deriveTrackerProgress` fallback path (no `summary` at all — a structural gap,
 * unrelated to RAP) to confirm it still renders the normal in-progress state, not "unavailable".
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TrackerCard } from './TrackerCard';
import type { CampaignDetailTracker, TrackerProgressSummary } from '../../types';

const TRACKER: CampaignDetailTracker = {
  trackerId: 10,
  trackerCode: 'SCS_TRACKER',
  trackerName: 'Grocery Streak',
  description: null,
  completionLogic: 'all',
  completionThreshold: null,
  rewards: [
    {
      id: 1,
      level: 'tracker',
      refId: 10,
      rewardPolicyId: 1,
      rewardPolicyName: 'policy',
      rewardId: 1,
      rewardName: 'Grocery Cashback',
      unitType: 'currency',
      unitCode: 'USD',
      amount: '20',
      status: 'active',
    },
  ],
  components: [
    {
      componentId: 1,
      componentCode: 'C1',
      componentName: 'First purchase',
      activityName: null,
      sequenceOrder: 1,
      isMandatory: true,
      completed: true,
    },
    {
      componentId: 2,
      componentCode: 'C2',
      componentName: 'Second purchase',
      activityName: null,
      sequenceOrder: 2,
      isMandatory: true,
      completed: false,
    },
  ],
};

function summary(overrides: Partial<TrackerProgressSummary>): TrackerProgressSummary {
  return {
    trackerId: 10,
    trackerCode: 'SCS_TRACKER',
    trackerName: 'Grocery Streak',
    completionLogic: 'all',
    completedCount: 1,
    threshold: 2,
    completed: false,
    progressUnknown: false,
    ...overrides,
  };
}

describe('TrackerCard', () => {
  it('TC-1: real RAP progress renders the actual X/Y numbers, not a placeholder', () => {
    render(<TrackerCard tracker={TRACKER} summary={summary({})} campaignRewards={[]} />);

    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: 'Grocery Streak progress' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/progress unavailable/i)).not.toBeInTheDocument();
  });

  it('TC-2: progressUnknown shows "progress unavailable," never a fake 0 or stale number', () => {
    render(
      <TrackerCard
        tracker={TRACKER}
        summary={summary({ completedCount: null, completed: null, progressUnknown: true })}
        campaignRewards={[]}
      />,
    );

    expect(
      screen.getByText('Progress unavailable right now — check back soon.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('0/2')).not.toBeInTheDocument();
    expect(screen.queryByText('1/2')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('progressbar', { name: 'Grocery Streak progress' }),
    ).not.toBeInTheDocument();
    // Reward not (yet) confirmed earned while progress is genuinely unknown.
    expect(screen.getByText('Not yet earned')).toBeInTheDocument();
  });

  it('TC-3: a tracker whose threshold is met shows "Complete"/"Earned", matching RAP\'s completed flag', () => {
    render(
      <TrackerCard
        tracker={TRACKER}
        summary={summary({ completedCount: 2, completed: true })}
        campaignRewards={[]}
      />,
    );

    expect(screen.getByText('Complete')).toBeInTheDocument();
    expect(screen.getByText('Earned')).toBeInTheDocument();
    expect(screen.queryByText('Not yet earned')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('progressbar', { name: 'Grocery Streak progress' }),
    ).not.toBeInTheDocument();
  });

  it('falls back to deriveTrackerProgress (real, known progress) when no summary is given at all', () => {
    render(<TrackerCard tracker={TRACKER} summary={undefined} campaignRewards={[]} />);

    // `TRACKER` has 1/2 components complete under `all` logic — a structural fallback, never
    // "unavailable" (that state is reserved for a real RAP failure, not a missing summary).
    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(screen.queryByText(/progress unavailable/i)).not.toBeInTheDocument();
  });

  it('renders every component and falls back to a campaign-level reward when the tracker has none of its own', () => {
    const trackerWithNoReward: CampaignDetailTracker = { ...TRACKER, rewards: [] };
    render(
      <TrackerCard
        tracker={trackerWithNoReward}
        summary={summary({})}
        campaignRewards={[
          {
            id: 2,
            level: 'campaign',
            refId: null,
            rewardPolicyId: 2,
            rewardPolicyName: 'campaign policy',
            rewardId: 2,
            rewardName: 'Campaign Bonus',
            unitType: 'points',
            unitCode: 'PTS',
            amount: null,
            status: 'active',
          },
        ]}
      />,
    );

    expect(screen.getByText('First purchase')).toBeInTheDocument();
    expect(screen.getByText('Second purchase')).toBeInTheDocument();
    expect(screen.getByText('Campaign Bonus')).toBeInTheDocument();
  });
});
