import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { UseQueryResult } from '@tanstack/react-query';
import { ActivityFeed } from './ActivityFeed';
import type { ActivityHistoryEntry } from '../../types';

function loadingQuery(): UseQueryResult<readonly ActivityHistoryEntry[]> {
  return { isLoading: true, isError: false, data: undefined } as UseQueryResult<
    readonly ActivityHistoryEntry[]
  >;
}

function errorQuery(message: string): UseQueryResult<readonly ActivityHistoryEntry[]> {
  return {
    isLoading: false,
    isError: true,
    data: undefined,
    error: new Error(message),
  } as UseQueryResult<readonly ActivityHistoryEntry[]>;
}

function successQuery(
  data: readonly ActivityHistoryEntry[],
): UseQueryResult<readonly ActivityHistoryEntry[]> {
  return {
    isLoading: false,
    isError: false,
    data,
  } as UseQueryResult<readonly ActivityHistoryEntry[]>;
}

describe('ActivityFeed', () => {
  it('shows a loading state', () => {
    render(<ActivityFeed query={loadingQuery()} />);
    expect(screen.getByText('Loading activity…')).toBeInTheDocument();
  });

  it('shows the real error message', () => {
    render(<ActivityFeed query={errorQuery('tracking-service down')} />);
    expect(
      screen.getByText("Couldn't load this customer's activity: tracking-service down"),
    ).toBeInTheDocument();
  });

  it('shows a sensible empty state, distinct from loading/error', () => {
    render(<ActivityFeed query={successQuery([])} />);
    expect(screen.getByText(/no activity yet/i)).toBeInTheDocument();
  });

  it('TC-4: renders this customer’s own real entries', () => {
    render(
      <ActivityFeed
        query={successQuery([
          {
            id: 'a1',
            customerId: 'marcus-tan',
            timestamp: '2026-06-01T14:32:00.000Z',
            activityType: 'Weekend Transaction',
            merchant: null,
            amount: null,
            description: 'Weekend Transaction — progress updated',
            matched: true,
            progress: [],
            rewards: [],
          },
        ])}
      />,
    );

    expect(screen.getByText('Weekend Transaction — progress updated')).toBeInTheDocument();
  });
});
