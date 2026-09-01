/**
 * T-006 — React Query hooks wrapping `apiClient.ts` (this task's Scope: "used via React Query
 * hooks ... so pages get caching/loading/error states for free"). T-007–T-010 consume these
 * rather than calling `apiClient` directly.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import * as apiClient from './apiClient';
import { queryKeys } from './queryKeys';
import type {
  ActivityHistoryEntry,
  ActivityRequest,
  ActivityResult,
  CampaignDetail,
  CampaignSummary,
  Customer,
  DashboardSummary,
  RewardLedgerEntry,
} from '../types';

export function useCustomers(): UseQueryResult<readonly Customer[]> {
  return useQuery({
    queryKey: queryKeys.customers,
    queryFn: apiClient.getCustomers,
    // The demo roster (`data/customers.ts`) is a fixed, hardcoded list server-side — never
    // changes for the lifetime of a session, so there's nothing to ever refetch it for.
    staleTime: Infinity,
  });
}

export function useDashboard(customerId: string | null): UseQueryResult<DashboardSummary> {
  return useQuery({
    queryKey: queryKeys.dashboard(customerId ?? ''),
    queryFn: () => apiClient.getDashboard(customerId as string),
    enabled: customerId !== null,
  });
}

export function useCampaigns(
  customerId?: string | null,
): UseQueryResult<readonly CampaignSummary[]> {
  return useQuery({
    queryKey: queryKeys.campaigns(customerId),
    queryFn: () => apiClient.getCampaigns(customerId),
  });
}

export function useCampaign(
  code: string | undefined,
  customerId?: string | null,
): UseQueryResult<CampaignDetail> {
  return useQuery({
    queryKey: queryKeys.campaign(code ?? '', customerId),
    queryFn: () => apiClient.getCampaign(code as string, customerId),
    enabled: Boolean(code),
  });
}

export function useRewards(
  customerId: string | null,
): UseQueryResult<readonly RewardLedgerEntry[]> {
  return useQuery({
    queryKey: queryKeys.rewards(customerId ?? ''),
    queryFn: () => apiClient.getRewards(customerId as string),
    enabled: customerId !== null,
  });
}

export function usePostActivity() {
  const queryClient = useQueryClient();
  return useMutation<ActivityResult, unknown, ActivityRequest>({
    mutationFn: (body) => apiClient.postActivity(body),
    onSuccess: (_result, variables) => {
      // `sseClient.ts`'s live event is the primary live-update mechanism (this task's TC-7); this
      // is belt-and-braces so the page that fired the activity self-heals on its own response
      // even if that customer's SSE connection is momentarily down.
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(variables.customerId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.campaignsRoot });
      void queryClient.invalidateQueries({ queryKey: queryKeys.campaignRoot });
      void queryClient.invalidateQueries({ queryKey: queryKeys.rewards(variables.customerId) });
      // T-010 — the Activity Simulator's own feed: this exact call is the one that just wrote a
      // new `ActivityHistoryEntry` server-side (T-013), so its feed must reconcile too, the same
      // belt-and-braces reasoning as the 4 invalidations above.
      void queryClient.invalidateQueries({ queryKey: queryKeys.activities(variables.customerId) });
    },
  });
}

/** T-010 — this customer's real activity history (`GET /api/activities`, T-013), most-recent-
 * first, feeding the Activity Simulator's live feed. */
export function useActivities(
  customerId: string | null,
): UseQueryResult<readonly ActivityHistoryEntry[]> {
  return useQuery({
    queryKey: queryKeys.activities(customerId ?? ''),
    queryFn: () => apiClient.getActivities(customerId as string),
    enabled: customerId !== null,
  });
}
