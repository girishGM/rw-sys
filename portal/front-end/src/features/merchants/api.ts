/**
 * T-036 — the `/merchants` calls, following the shape `features/tenants/api.ts` (T-034)
 * establishes: `lib/apiClient.ts`'s shared `api` instance, and every response parsed through the
 * matching `packages/shared/src/merchant.schema.ts` schema — not just cast — so a server/SPA
 * contract drift surfaces as a caught, reported error on this feature rather than as a silent
 * `undefined` deep in a form.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  createMerchantActivityRequestSchema,
  createMerchantStoreRequestSchema,
  merchantActiveCampaignListEnvelopeSchema,
  merchantActivityEnvelopeSchema,
  merchantActivityListEnvelopeSchema,
  merchantEnvelopeSchema,
  merchantListEnvelopeSchema,
  merchantStoreEnvelopeSchema,
  merchantStoreListEnvelopeSchema,
  type CreateMerchantActivityRequest,
  type CreateMerchantRequest,
  type CreateMerchantStoreRequest,
  type Merchant,
  type MerchantActiveCampaign,
  type MerchantActivity,
  type MerchantStore,
  type UpdateMerchantRequest,
} from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { toApiError } from '../../lib/apiError';

export interface MerchantListParams {
  readonly page?: number;
  readonly pageSize?: number;
  readonly sort?: string;
  readonly search?: string;
}

export interface MerchantListResult {
  readonly data: readonly Merchant[];
  readonly meta: { readonly page: number; readonly pageSize: number; readonly total: number };
}

/** The root key every `/merchants` query hangs off, so a mutation can invalidate all of it at
 * once. */
export const MERCHANTS_ROOT_KEY = ['merchants'] as const;

export function merchantsQueryKey(
  params: MerchantListParams = {},
): readonly [string, MerchantListParams] {
  return ['merchants', params] as const;
}

export async function fetchMerchants(params: MerchantListParams): Promise<MerchantListResult> {
  try {
    const response = await api.get<unknown>('/merchants', { params });
    const parsed = merchantListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Merchants list response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useMerchantsQuery(
  params: MerchantListParams = {},
): UseQueryResult<MerchantListResult, ReturnType<typeof toApiError>> {
  return useQuery({
    queryKey: merchantsQueryKey(params),
    queryFn: () => fetchMerchants(params),
  });
}

export function merchantQueryKey(id: number): readonly [string, number] {
  return ['merchants', id] as const;
}

export async function fetchMerchant(id: number): Promise<Merchant> {
  try {
    const response = await api.get<unknown>(`/merchants/${String(id)}`);
    const parsed = merchantEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Merchant response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useMerchantQuery(id: number) {
  return useQuery({ queryKey: merchantQueryKey(id), queryFn: () => fetchMerchant(id) });
}

export async function createMerchant(input: CreateMerchantRequest): Promise<Merchant> {
  try {
    const response = await api.post<unknown>('/merchants', input);
    const parsed = merchantEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-merchant response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCreateMerchantMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createMerchant,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MERCHANTS_ROOT_KEY });
    },
  });
}

export async function updateMerchant(id: number, input: UpdateMerchantRequest): Promise<Merchant> {
  try {
    const response = await api.patch<unknown>(`/merchants/${String(id)}`, input);
    const parsed = merchantEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Update-merchant response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useUpdateMerchantMutation(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMerchantRequest) => updateMerchant(id, input),
    onSuccess: (merchant) => {
      queryClient.setQueryData(merchantQueryKey(id), merchant);
      void queryClient.invalidateQueries({ queryKey: MERCHANTS_ROOT_KEY });
    },
  });
}

/** Implementation note 7 / TC-20 — the data source behind the deactivation-warning confirm
 * dialog, the same shape `features/countries/api.ts#fetchCountrySummary` establishes. */
export function activeCampaignsQueryKey(merchantId: number): readonly [string, number, string] {
  return ['merchants', merchantId, 'active-campaigns'] as const;
}

export async function fetchActiveCampaigns(
  merchantId: number,
): Promise<readonly MerchantActiveCampaign[]> {
  try {
    const response = await api.get<unknown>(`/merchants/${String(merchantId)}/active-campaigns`);
    const parsed = merchantActiveCampaignListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Active-campaigns response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useActiveCampaignsQuery(merchantId: number) {
  return useQuery({
    queryKey: activeCampaignsQueryKey(merchantId),
    queryFn: () => fetchActiveCampaigns(merchantId),
  });
}

export function storesQueryKey(merchantId: number): readonly [string, number, string] {
  return ['merchants', merchantId, 'stores'] as const;
}

export async function fetchStores(merchantId: number): Promise<readonly MerchantStore[]> {
  try {
    const response = await api.get<unknown>(`/merchants/${String(merchantId)}/stores`);
    const parsed = merchantStoreListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Stores response did not match the expected shape: ${parsed.error.message}`);
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useStoresQuery(merchantId: number) {
  return useQuery({ queryKey: storesQueryKey(merchantId), queryFn: () => fetchStores(merchantId) });
}

export async function createStore(
  merchantId: number,
  input: CreateMerchantStoreRequest,
): Promise<MerchantStore> {
  try {
    const parsedInput = createMerchantStoreRequestSchema.parse(input);
    const response = await api.post<unknown>(
      `/merchants/${String(merchantId)}/stores`,
      parsedInput,
    );
    const parsed = merchantStoreEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-store response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCreateStoreMutation(merchantId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMerchantStoreRequest) => createStore(merchantId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: storesQueryKey(merchantId) });
    },
  });
}

export function activitiesQueryKey(merchantId: number): readonly [string, number, string] {
  return ['merchants', merchantId, 'activities'] as const;
}

export async function fetchActivities(merchantId: number): Promise<readonly MerchantActivity[]> {
  try {
    const response = await api.get<unknown>(`/merchants/${String(merchantId)}/activities`);
    const parsed = merchantActivityListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Activities response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useActivitiesQuery(merchantId: number) {
  return useQuery({
    queryKey: activitiesQueryKey(merchantId),
    queryFn: () => fetchActivities(merchantId),
  });
}

export async function createActivity(
  merchantId: number,
  input: CreateMerchantActivityRequest,
): Promise<MerchantActivity> {
  try {
    const parsedInput = createMerchantActivityRequestSchema.parse(input);
    const response = await api.post<unknown>(
      `/merchants/${String(merchantId)}/activities`,
      parsedInput,
    );
    const parsed = merchantActivityEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-activity response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCreateActivityMutation(merchantId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMerchantActivityRequest) => createActivity(merchantId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: activitiesQueryKey(merchantId) });
    },
  });
}
