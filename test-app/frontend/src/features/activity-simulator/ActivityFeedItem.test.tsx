import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActivityFeedItem } from './ActivityFeedItem';
import type { ActivityHistoryEntry } from '../../types';

function baseEntry(overrides: Partial<ActivityHistoryEntry> = {}): ActivityHistoryEntry {
  return {
    id: 'a1',
    customerId: 'priya-shah',
    timestamp: '2026-06-01T14:32:00.000Z',
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

describe('ActivityFeedItem', () => {
  it('TC-1: shows the real progress delta for a matched, non-completing activity', () => {
    render(
      <ul>
        <ActivityFeedItem
          entry={baseEntry({
            progress: [
              {
                campaignId: 1,
                campaignCode: 'SUMMER_CASHBACK_SPRINT',
                campaignName: 'Summer Cashback Sprint',
                trackerId: 10,
                trackerCode: 'SCS_TRACKER',
                trackerName: 'Grocery Streak',
                componentId: 100,
                completedCount: 4,
                threshold: 5,
                trackerCompleted: false,
              },
            ],
          })}
        />
      </ul>,
    );

    expect(screen.getByText('Grocery Streak: 4 of 5')).toBeInTheDocument();
    expect(screen.queryByText(/reward/i)).not.toBeInTheDocument();
  });

  it('TC-2: shows the real reward badge when this activity minted one', () => {
    render(
      <ul>
        <ActivityFeedItem
          entry={baseEntry({
            description: 'Weekend Transaction — reward earned (cashback)',
            rewards: [
              {
                id: 'r1',
                customerId: 'priya-shah',
                campaignId: 3,
                campaignCode: 'WEEKEND_PROMO_BLITZ',
                type: 'cashback',
                value: '15',
                currency: 'USD',
                status: 'unused',
                issuedAt: '2026-06-01T14:32:00.000Z',
                expiresAt: null,
              },
            ],
          })}
        />
      </ul>,
    );

    expect(screen.getByText('$15.00 cashback')).toBeInTheDocument();
  });

  it('TC-5: shows a real "no match" description, not a false-positive reward badge', () => {
    render(
      <ul>
        <ActivityFeedItem
          entry={baseEntry({
            activityType: 'Unknown Activity',
            description: 'Unknown Activity — no matching tracker',
            matched: false,
          })}
        />
      </ul>,
    );

    expect(screen.getByText('Unknown Activity — no matching tracker')).toBeInTheDocument();
    expect(screen.queryByText(/cashback|points|promo code/i)).not.toBeInTheDocument();
  });

  it('renders merchant + amount when present', () => {
    render(
      <ul>
        <ActivityFeedItem entry={baseEntry({ merchant: 'Fresh Mart', amount: 42.5 })} />
      </ul>,
    );

    expect(screen.getByText('Fresh Mart · $42.50')).toBeInTheDocument();
  });
});
