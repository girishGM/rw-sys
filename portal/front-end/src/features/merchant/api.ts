/**
 * T-039 — the three `/merchant/*` calls, following the shape `features/merchants/api.ts`
 * (T-036) and `features/trace/api.ts` (T-045) establish: `lib/apiClient.ts`'s shared `api`
 * instance (T-022), and every response parsed through the matching
 * `packages/shared/src/merchant-portal.schema.ts` schema — not just cast — so a server/SPA
 * contract drift surfaces as a caught, reported error on this feature rather than as a silent
 * `undefined` deep in a widget or the campaign detail drawer.
 */
import { useQuery } from '@tanstack/react-query';
import {
  merchantCampaignDetailEnvelopeSchema,
  merchantCampaignListEnvelopeSchema,
  merchantSummaryEnvelopeSchema,
  type MerchantCampaignDetail,
  type MerchantCampaignListItem,
  type MerchantSummary,
} from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { toApiError } from '../../lib/apiError';

/** The root key every `/merchant/campaigns` query hangs off. */
export const MERCHANT_CAMPAIGNS_ROOT_KEY = ['merchant-campaigns'] as const;

export function merchantCampaignsQueryKey(): readonly [string] {
  return ['merchant-campaigns'] as const;
}

export async function fetchMerchantCampaigns(): Promise<readonly MerchantCampaignListItem[]> {
  try {
    const response = await api.get<unknown>('/merchant/campaigns');
    const parsed = merchantCampaignListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Merchant campaigns response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useMerchantCampaignsQuery() {
  return useQuery({
    queryKey: merchantCampaignsQueryKey(),
    queryFn: fetchMerchantCampaigns,
  });
}

export function merchantCampaignQueryKey(id: number): readonly [string, number] {
  return ['merchant-campaigns', id] as const;
}

/** TC-3/TC-4 surface here as an ordinary `ApiError` with `status === 404` — the campaign either
 * does not exist, is not this merchant's participation, or belongs to another tenant, all
 * indistinguishable by design (the same 02-SECURITY.md §5.1 shape every other scoped read uses). */
export async function fetchMerchantCampaign(id: number): Promise<MerchantCampaignDetail> {
  try {
    const response = await api.get<unknown>(`/merchant/campaigns/${String(id)}`);
    const parsed = merchantCampaignDetailEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Merchant campaign detail response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useMerchantCampaignQuery(id: number | null) {
  return useQuery({
    queryKey: merchantCampaignQueryKey(id ?? -1),
    queryFn: () => fetchMerchantCampaign(id as number),
    enabled: id !== null,
  });
}

export function merchantSummaryQueryKey(): readonly [string] {
  return ['merchant-summary'] as const;
}

export async function fetchMerchantSummary(): Promise<MerchantSummary> {
  try {
    const response = await api.get<unknown>('/merchant/summary');
    const parsed = merchantSummaryEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Merchant summary response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useMerchantSummaryQuery() {
  return useQuery({
    queryKey: merchantSummaryQueryKey(),
    queryFn: fetchMerchantSummary,
  });
}
