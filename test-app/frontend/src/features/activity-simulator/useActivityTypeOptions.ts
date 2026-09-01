/**
 * T-010 — this task's Scope: "Activity type ... options should be derived from real data where
 * possible (the activities `tracking-service` actually recognizes) rather than a hardcoded,
 * possibly-stale list." The one real source for "an activity type `tracking-service` actually
 * recognizes" is `CampaignDetailComponent.activityName` (`GET /api/campaigns/:code`, T-006's own
 * `types/campaign.ts`) — `engine/evaluate.ts`'s `findComponentToComplete` (`tracking-service`)
 * matches an incoming `activityType` against exactly this field, case/whitespace-insensitively, so
 * every distinct, non-null `activityName` across every campaign's every component is, by
 * construction, a real value `POST /api/activities` can act on for *some* customer/tracker.
 *
 * Not customer-scoped on purpose — this is "what activity types exist at all", not "what this
 * customer still needs"; a value that's already complete for the selected customer is still a
 * legitimate option (submitting it is exactly this task's TC-5: a real, sensible "no progress"
 * case, not an invalid one). `getCampaign` is called with no `customerId` (`queryKeys.campaign`'s
 * own `customerId ?? null` collapses that to a `null`-keyed cache entry distinct from any
 * customer-scoped call elsewhere, e.g. `TrackerRow`'s), so this hook's own fetches are shared
 * across every customer, not re-fetched on every switch.
 */
import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { getCampaign } from '../../lib/apiClient';
import { queryKeys } from '../../lib/queryKeys';
import { useCampaigns } from '../../lib/queries';

export interface ActivityTypeOptions {
  readonly options: readonly string[];
  readonly isLoading: boolean;
}

export function useActivityTypeOptions(): ActivityTypeOptions {
  const campaignsQuery = useCampaigns();
  const codes = campaignsQuery.data?.map((campaign) => campaign.campaignCode) ?? [];

  const detailQueries = useQueries({
    queries: codes.map((code) => ({
      queryKey: queryKeys.campaign(code, null),
      queryFn: () => getCampaign(code),
    })),
  });

  const options = useMemo(() => {
    const names = new Set<string>();
    for (const query of detailQueries) {
      for (const tracker of query.data?.trackers ?? []) {
        for (const component of tracker.components) {
          if (component.activityName !== null) names.add(component.activityName);
        }
      }
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [detailQueries]);

  const isLoading =
    campaignsQuery.isLoading ||
    (codes.length > 0 && detailQueries.some((query) => query.isLoading));

  return { options, isLoading };
}
