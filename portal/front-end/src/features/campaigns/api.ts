/**
 * T-037 — the `/campaigns` calls, following the shape `features/merchants/api.ts` (T-036)
 * establishes: `lib/apiClient.ts`'s shared `api` instance, and every response parsed through the
 * matching `packages/shared/src/campaign.schema.ts` schema — not just cast — so a server/SPA
 * contract drift surfaces as a caught, reported error on this feature rather than as a silent
 * `undefined` deep in a form.
 *
 * ### One query key per campaign, invalidated wholesale
 *
 * Every journey mutation (`POST /trackers`, `POST /rules`, `POST /rewards`, …) returns the **whole
 * refreshed journey** rather than the created row, so the wizard never has to reconcile a
 * partial response into its own tree. The mutations below therefore write the response straight
 * into the journey cache and invalidate the campaign's other keys, which is what keeps step 5's
 * reward tree and step 6's warnings in step with step 3 without a manual refetch.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';
import {
  campaignActivityOptionListEnvelopeSchema,
  campaignAuditListEnvelopeSchema,
  campaignCapsEnvelopeSchema,
  campaignEnvelopeSchema,
  campaignListEnvelopeSchema,
  campaignMerchantListEnvelopeSchema,
  campaignReviewEnvelopeSchema,
  journeyEnvelopeSchema,
  rewardOptionListEnvelopeSchema,
  ruleOptionListEnvelopeSchema,
  submitCampaignEnvelopeSchema,
  type AttachRewardRequest,
  type BindComponentRuleRequest,
  type Campaign,
  type CampaignActivityOption,
  type CampaignAuditEntry,
  type CampaignCapsResponse,
  type CampaignMerchantLink,
  type CampaignReview,
  type CreateCampaignRequest,
  type CreateComponentRequest,
  type CreateTrackerRequest,
  type Journey,
  type PutCampaignCapsRequest,
  type ReorderComponentsRequest,
  type RewardLevel,
  type RewardOption,
  type RuleOption,
  type SetCampaignMerchantsRequest,
  type SubmitCampaignResponse,
  type UpdateCampaignRequest,
  type UpdateComponentRequest,
  type UpdateComponentRuleValuesRequest,
  type UpdateTrackerRequest,
} from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { toApiError } from '../../lib/apiError';

export interface CampaignListParams {
  readonly page?: number;
  readonly pageSize?: number;
  readonly sort?: string;
  readonly status?: string;
  readonly search?: string;
}

export interface CampaignListResult {
  readonly data: readonly Campaign[];
  readonly meta: { readonly page: number; readonly pageSize: number; readonly total: number };
}

/** The root key every `/campaigns` query hangs off, so a mutation can invalidate all of it. */
export const CAMPAIGNS_ROOT_KEY = ['campaigns'] as const;

export function campaignsQueryKey(params: CampaignListParams = {}) {
  return ['campaigns', params] as const;
}
export function campaignQueryKey(id: number) {
  return ['campaigns', id] as const;
}
export function journeyQueryKey(id: number) {
  return ['campaigns', id, 'journey'] as const;
}
export function capsQueryKey(id: number) {
  return ['campaigns', id, 'caps'] as const;
}
export function reviewQueryKey(id: number) {
  return ['campaigns', id, 'review'] as const;
}
export function merchantsQueryKey(id: number) {
  return ['campaigns', id, 'merchants'] as const;
}
export function activityOptionsQueryKey(id: number) {
  return ['campaigns', id, 'activities'] as const;
}
export function ruleOptionsQueryKey(id: number) {
  return ['campaigns', id, 'rule-options'] as const;
}
export function rewardOptionsQueryKey(id: number) {
  return ['campaigns', id, 'reward-options'] as const;
}
export function auditQueryKey(id: number) {
  return ['campaigns', id, 'audit'] as const;
}
/** T-127 — not campaign-scoped: the same provider answers the same list for every campaign, so
 * caching it per campaign id would refetch it once per wizard rather than once per session. */
export function apiLookupOptionsQueryKey(providerCode: string) {
  return ['field-value-sources', 'api', providerCode] as const;
}

/** Parses `payload` or throws a readable contract error. One helper rather than the same nine
 * lines per call, which is how one of them ends up not parsing at all. */
function parsed<T>(
  schema: {
    safeParse: (input: unknown) => { success: boolean; data?: T; error?: { message: string } };
  },
  payload: unknown,
  what: string,
): T {
  const result = schema.safeParse(payload);
  if (!result.success || result.data === undefined) {
    throw new Error(
      `${what} response did not match the expected shape: ${result.error?.message ?? ''}`,
    );
  }
  return result.data;
}

// --- reads ---------------------------------------------------------------------------------------

export async function fetchCampaigns(params: CampaignListParams): Promise<CampaignListResult> {
  try {
    const response = await api.get<unknown>('/campaigns', { params });
    return parsed(campaignListEnvelopeSchema, response.data, 'Campaigns list');
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCampaignsQuery(
  params: CampaignListParams = {},
): UseQueryResult<CampaignListResult, ReturnType<typeof toApiError>> {
  return useQuery({ queryKey: campaignsQueryKey(params), queryFn: () => fetchCampaigns(params) });
}

export async function fetchCampaign(id: number): Promise<Campaign> {
  try {
    const response = await api.get<unknown>(`/campaigns/${String(id)}`);
    return parsed(campaignEnvelopeSchema, response.data, 'Campaign').data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCampaignQuery(id: number | null) {
  return useQuery({
    queryKey: campaignQueryKey(id ?? 0),
    queryFn: () => fetchCampaign(id as number),
    enabled: id !== null,
  });
}

export async function fetchJourney(id: number): Promise<Journey> {
  try {
    const response = await api.get<unknown>(`/campaigns/${String(id)}/journey`);
    return parsed(journeyEnvelopeSchema, response.data, 'Journey').data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useJourneyQuery(id: number | null) {
  return useQuery({
    queryKey: journeyQueryKey(id ?? 0),
    queryFn: () => fetchJourney(id as number),
    enabled: id !== null,
  });
}

export async function fetchCampaignMerchants(id: number): Promise<readonly CampaignMerchantLink[]> {
  try {
    const response = await api.get<unknown>(`/campaigns/${String(id)}/merchants`);
    return parsed(campaignMerchantListEnvelopeSchema, response.data, 'Campaign merchants').data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCampaignMerchantsQuery(id: number | null) {
  return useQuery({
    queryKey: merchantsQueryKey(id ?? 0),
    queryFn: () => fetchCampaignMerchants(id as number),
    enabled: id !== null,
  });
}

export async function fetchActivityOptions(id: number): Promise<readonly CampaignActivityOption[]> {
  try {
    const response = await api.get<unknown>(`/campaigns/${String(id)}/activities`);
    return parsed(campaignActivityOptionListEnvelopeSchema, response.data, 'Activity options').data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useActivityOptionsQuery(id: number | null) {
  return useQuery({
    queryKey: activityOptionsQueryKey(id ?? 0),
    queryFn: () => fetchActivityOptions(id as number),
    enabled: id !== null,
  });
}

export async function fetchRuleOptions(id: number): Promise<readonly RuleOption[]> {
  try {
    const response = await api.get<unknown>(`/campaigns/${String(id)}/rule-options`);
    return parsed(ruleOptionListEnvelopeSchema, response.data, 'Rule options').data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useRuleOptionsQuery(id: number | null) {
  return useQuery({
    queryKey: ruleOptionsQueryKey(id ?? 0),
    queryFn: () => fetchRuleOptions(id as number),
    enabled: id !== null,
  });
}

export async function fetchRewardOptions(id: number): Promise<readonly RewardOption[]> {
  try {
    const response = await api.get<unknown>(`/campaigns/${String(id)}/reward-options`);
    return parsed(rewardOptionListEnvelopeSchema, response.data, 'Reward options').data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useRewardOptionsQuery(id: number | null) {
  return useQuery({
    queryKey: rewardOptionsQueryKey(id ?? 0),
    queryFn: () => fetchRewardOptions(id as number),
    enabled: id !== null,
  });
}

/**
 * T-127 — `GET /field-value-sources/api/:providerCode` (T-123), the live dropdown behind step 5's
 * Promo Code Config picker.
 *
 * The response shape is declared here rather than imported from `packages/shared`: T-123 documents
 * `{ value, label }` per item in its own service header but publishes no schema for it (the shared
 * `field-value-source.schema.ts` covers the *registries*, not this runtime lookup), and inventing
 * one there would be editing another task's file. `value` is `string | number` exactly as that
 * header states — the promo code service is unbuilt, so which of the two it will answer with is
 * genuinely not yet decided.
 */
const apiLookupOptionSchema = z
  .object({ value: z.union([z.string(), z.number()]), label: z.string() })
  .strict();

const apiLookupOptionListEnvelopeSchema = z
  .object({ data: z.array(apiLookupOptionSchema) })
  .strict();

export type ApiLookupOption = z.infer<typeof apiLookupOptionSchema>;

export async function fetchApiLookupOptions(
  providerCode: string,
): Promise<readonly ApiLookupOption[]> {
  try {
    const response = await api.get<unknown>(
      `/field-value-sources/api/${encodeURIComponent(providerCode)}`,
    );
    return parsed(apiLookupOptionListEnvelopeSchema, response.data, 'Field value options').data;
  } catch (error) {
    throw toApiError(error);
  }
}

/**
 * A `planned` provider answers 501 (`FIELD_LOOKUP_PROVIDER_NOT_AVAILABLE`) and will keep answering
 * 501 until somebody builds it — so `retry: false`: retrying a "this does not exist yet" is three
 * more requests for the same answer, and the picker's job is to say so calmly, not to keep asking.
 */
export function useApiLookupOptionsQuery(providerCode: string | null) {
  return useQuery({
    queryKey: apiLookupOptionsQueryKey(providerCode ?? ''),
    queryFn: () => fetchApiLookupOptions(providerCode as string),
    enabled: providerCode !== null,
    retry: false,
  });
}

export async function fetchCaps(id: number): Promise<CampaignCapsResponse> {
  try {
    const response = await api.get<unknown>(`/campaigns/${String(id)}/caps`);
    return parsed(campaignCapsEnvelopeSchema, response.data, 'Campaign caps').data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCapsQuery(id: number | null) {
  return useQuery({
    queryKey: capsQueryKey(id ?? 0),
    queryFn: () => fetchCaps(id as number),
    enabled: id !== null,
  });
}

export async function fetchReview(id: number): Promise<CampaignReview> {
  try {
    const response = await api.get<unknown>(`/campaigns/${String(id)}/review`);
    return parsed(campaignReviewEnvelopeSchema, response.data, 'Campaign review').data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useReviewQuery(id: number | null, enabled = true) {
  return useQuery({
    queryKey: reviewQueryKey(id ?? 0),
    queryFn: () => fetchReview(id as number),
    enabled: id !== null && enabled,
  });
}

export async function fetchAudit(id: number): Promise<readonly CampaignAuditEntry[]> {
  try {
    const response = await api.get<unknown>(`/campaigns/${String(id)}/audit`);
    return parsed(campaignAuditListEnvelopeSchema, response.data, 'Campaign audit').data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useAuditQuery(id: number | null) {
  return useQuery({
    queryKey: auditQueryKey(id ?? 0),
    queryFn: () => fetchAudit(id as number),
    enabled: id !== null,
  });
}

// --- writes --------------------------------------------------------------------------------------

export async function createCampaign(input: CreateCampaignRequest): Promise<Campaign> {
  try {
    const response = await api.post<unknown>('/campaigns', input);
    return parsed(campaignEnvelopeSchema, response.data, 'Create campaign').data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCreateCampaignMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createCampaign,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CAMPAIGNS_ROOT_KEY });
    },
  });
}

export async function updateCampaign(id: number, input: UpdateCampaignRequest): Promise<Campaign> {
  try {
    const response = await api.patch<unknown>(`/campaigns/${String(id)}`, input);
    return parsed(campaignEnvelopeSchema, response.data, 'Update campaign').data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useUpdateCampaignMutation(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateCampaignRequest) => updateCampaign(id, input),
    onSuccess: (campaign) => {
      queryClient.setQueryData(campaignQueryKey(id), campaign);
      void queryClient.invalidateQueries({ queryKey: CAMPAIGNS_ROOT_KEY });
    },
  });
}

export async function setCampaignMerchants(
  id: number,
  input: SetCampaignMerchantsRequest,
): Promise<readonly CampaignMerchantLink[]> {
  try {
    const response = await api.post<unknown>(`/campaigns/${String(id)}/merchants`, input);
    return parsed(campaignMerchantListEnvelopeSchema, response.data, 'Campaign merchants').data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useSetMerchantsMutation(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetCampaignMerchantsRequest) => setCampaignMerchants(id, input),
    onSuccess: (merchants) => {
      queryClient.setQueryData(merchantsQueryKey(id), merchants);
      // Step 2 decides which activities step 3 may offer, so this cache must not go stale.
      void queryClient.invalidateQueries({ queryKey: activityOptionsQueryKey(id) });
      void queryClient.invalidateQueries({ queryKey: reviewQueryKey(id) });
    },
  });
}

/** Every journey mutation returns the refreshed tree — see this file's header. */
async function journeyMutation(
  request: () => Promise<{ data: unknown }>,
  what: string,
): Promise<Journey> {
  try {
    const response = await request();
    return parsed(journeyEnvelopeSchema, response.data, what).data;
  } catch (error) {
    throw toApiError(error);
  }
}

function useJourneyMutation<TInput>(id: number, run: (input: TInput) => Promise<Journey>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (journey) => {
      queryClient.setQueryData(journeyQueryKey(id), journey);
      void queryClient.invalidateQueries({ queryKey: capsQueryKey(id) });
      void queryClient.invalidateQueries({ queryKey: reviewQueryKey(id) });
    },
  });
}

export function useCreateTrackerMutation(id: number) {
  return useJourneyMutation<CreateTrackerRequest>(id, (input) =>
    journeyMutation(
      () => api.post<unknown>(`/campaigns/${String(id)}/trackers`, input),
      'Create tracker',
    ),
  );
}

export function useUpdateTrackerMutation(id: number) {
  return useJourneyMutation<{ trackerId: number; input: UpdateTrackerRequest }>(
    id,
    ({ trackerId, input }) =>
      journeyMutation(
        () => api.patch<unknown>(`/campaigns/${String(id)}/trackers/${String(trackerId)}`, input),
        'Update tracker',
      ),
  );
}

export function useDeleteTrackerMutation(id: number) {
  return useJourneyMutation<number>(id, (trackerId) =>
    journeyMutation(
      () => api.delete<unknown>(`/campaigns/${String(id)}/trackers/${String(trackerId)}`),
      'Delete tracker',
    ),
  );
}

export function useCreateComponentMutation(id: number) {
  return useJourneyMutation<{ trackerId: number; input: CreateComponentRequest }>(
    id,
    ({ trackerId, input }) =>
      journeyMutation(
        () =>
          api.post<unknown>(
            `/campaigns/${String(id)}/trackers/${String(trackerId)}/components`,
            input,
          ),
        'Create component',
      ),
  );
}

export function useUpdateComponentMutation(id: number) {
  return useJourneyMutation<{ componentId: number; input: UpdateComponentRequest }>(
    id,
    ({ componentId, input }) =>
      journeyMutation(
        () =>
          api.patch<unknown>(`/campaigns/${String(id)}/components/${String(componentId)}`, input),
        'Update component',
      ),
  );
}

export function useDeleteComponentMutation(id: number) {
  return useJourneyMutation<number>(id, (componentId) =>
    journeyMutation(
      () => api.delete<unknown>(`/campaigns/${String(id)}/components/${String(componentId)}`),
      'Delete component',
    ),
  );
}

export function useReorderComponentsMutation(id: number) {
  return useJourneyMutation<{ trackerId: number; input: ReorderComponentsRequest }>(
    id,
    ({ trackerId, input }) =>
      journeyMutation(
        () =>
          api.patch<unknown>(`/campaigns/${String(id)}/trackers/${String(trackerId)}/order`, input),
        'Reorder components',
      ),
  );
}

export function useBindRuleMutation(id: number) {
  return useJourneyMutation<BindComponentRuleRequest>(id, (input) =>
    journeyMutation(() => api.post<unknown>(`/campaigns/${String(id)}/rules`, input), 'Bind rule'),
  );
}

export function useUpdateRuleValuesMutation(id: number) {
  return useJourneyMutation<{ bindingId: number; input: UpdateComponentRuleValuesRequest }>(
    id,
    ({ bindingId, input }) =>
      journeyMutation(
        () => api.patch<unknown>(`/campaigns/${String(id)}/rules/${String(bindingId)}`, input),
        'Update rule values',
      ),
  );
}

export function useUnbindRuleMutation(id: number) {
  return useJourneyMutation<number>(id, (bindingId) =>
    journeyMutation(
      () => api.delete<unknown>(`/campaigns/${String(id)}/rules/${String(bindingId)}`),
      'Unbind rule',
    ),
  );
}

export function useAttachRewardMutation(id: number) {
  return useJourneyMutation<AttachRewardRequest>(id, (input) =>
    journeyMutation(
      () => api.post<unknown>(`/campaigns/${String(id)}/rewards`, input),
      'Attach reward',
    ),
  );
}

export function useDetachRewardMutation(id: number) {
  return useJourneyMutation<{ level: RewardLevel; assignmentId: number }>(
    id,
    ({ level, assignmentId }) =>
      journeyMutation(
        () =>
          api.delete<unknown>(`/campaigns/${String(id)}/rewards/${level}/${String(assignmentId)}`),
        'Detach reward',
      ),
  );
}

export async function putCaps(
  id: number,
  input: PutCampaignCapsRequest,
): Promise<CampaignCapsResponse> {
  try {
    const response = await api.put<unknown>(`/campaigns/${String(id)}/caps`, input);
    return parsed(campaignCapsEnvelopeSchema, response.data, 'Campaign caps').data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function usePutCapsMutation(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PutCampaignCapsRequest) => putCaps(id, input),
    onSuccess: (caps) => {
      queryClient.setQueryData(capsQueryKey(id), caps);
      void queryClient.invalidateQueries({ queryKey: campaignQueryKey(id) });
      void queryClient.invalidateQueries({ queryKey: reviewQueryKey(id) });
    },
  });
}

export async function submitCampaign(id: number): Promise<SubmitCampaignResponse> {
  try {
    const response = await api.post<unknown>(`/campaigns/${String(id)}/submit`, {});
    return parsed(submitCampaignEnvelopeSchema, response.data, 'Submit campaign').data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useSubmitCampaignMutation(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => submitCampaign(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CAMPAIGNS_ROOT_KEY });
    },
  });
}
