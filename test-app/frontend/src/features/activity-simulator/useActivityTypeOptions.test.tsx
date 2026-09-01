/**
 * T-010 — `useActivityTypeOptions`'s own contract: the option list is the real, deduped, sorted
 * set of non-null `activityName` values across every campaign's every component — not a
 * hardcoded list — and stays empty/loading-aware until the real data has arrived.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import * as apiClient from '../../lib/apiClient';
import { useActivityTypeOptions } from './useActivityTypeOptions';
import type { CampaignDetail, CampaignSummary } from '../../types';

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function summary(code: string): CampaignSummary {
  return {
    campaignId: code.length,
    campaignCode: code,
    name: code,
    description: null,
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    status: 'active',
    progress: null,
  };
}

function detailWithActivities(code: string, activityNames: (string | null)[]): CampaignDetail {
  return {
    campaignId: code.length,
    campaignCode: code,
    name: code,
    description: null,
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    status: 'active',
    campaignRewards: [],
    trackers: [
      {
        trackerId: 1,
        trackerCode: `${code}_T`,
        trackerName: 'tracker',
        description: null,
        completionLogic: 'all',
        completionThreshold: null,
        rewards: [],
        components: activityNames.map((activityName, index) => ({
          componentId: index + 1,
          componentCode: `C${index + 1}`,
          componentName: `component ${index + 1}`,
          activityName,
          sequenceOrder: index,
          isMandatory: true,
          completed: false,
        })),
      },
    ],
  };
}

describe('useActivityTypeOptions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts empty and loading before campaigns resolve', () => {
    vi.spyOn(apiClient, 'getCampaigns').mockReturnValue(new Promise(() => {}));
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useActivityTypeOptions(), {
      wrapper: wrapperFor(queryClient),
    });

    expect(result.current.options).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });

  it('dedupes + sorts real, non-null activityName values across every campaign/component', async () => {
    vi.spyOn(apiClient, 'getCampaigns').mockResolvedValue([
      summary('SUMMER_CASHBACK_SPRINT'),
      summary('WEEKEND_PROMO_BLITZ'),
    ]);
    vi.spyOn(apiClient, 'getCampaign').mockImplementation(async (code) =>
      code === 'SUMMER_CASHBACK_SPRINT'
        ? detailWithActivities(code, ['Grocery Purchase', 'Online Purchase', null])
        : detailWithActivities(code, ['Weekend Transaction', 'Grocery Purchase']),
    );
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useActivityTypeOptions(), {
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.options).toEqual([
      'Grocery Purchase',
      'Online Purchase',
      'Weekend Transaction',
    ]);
  });

  it('stays empty when there are no campaigns at all', async () => {
    vi.spyOn(apiClient, 'getCampaigns').mockResolvedValue([]);
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useActivityTypeOptions(), {
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.options).toEqual([]);
  });
});
