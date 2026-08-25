/**
 * T-032 — the `/rewards` calls, following the shape `features/rules/api.ts` (T-031) establishes:
 * `lib/apiClient.ts`'s shared `api` instance, and every response parsed through the matching
 * `packages/shared/src/reward.schema.ts` schema — not just cast — so a server/SPA contract drift
 * surfaces as a caught, reported error on this feature rather than as a silent `undefined` deep
 * in a form.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  assignRewardCountryRequestSchema,
  createRewardPolicyRequestSchema,
  createRewardRequestSchema,
  rewardCountryAssignmentEnvelopeSchema,
  rewardCountryAssignmentListEnvelopeSchema,
  rewardEnvelopeSchema,
  rewardListEnvelopeSchema,
  rewardPolicyEnvelopeSchema,
  rewardPolicyListEnvelopeSchema,
  updateRewardPolicyRequestSchema,
  updateRewardRequestSchema,
  type AssignRewardCountryRequest,
  type CreateRewardPolicyRequest,
  type CreateRewardRequest,
  type Reward,
  type RewardCountryAssignment,
  type RewardListItem,
  type RewardPolicy,
  type UpdateRewardPolicyRequest,
  type UpdateRewardRequest,
} from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { toApiError } from '../../lib/apiError';

export interface RewardListParams {
  readonly page?: number;
  readonly pageSize?: number;
  readonly status?: string;
  readonly sort?: string;
}

export interface RewardListResult {
  readonly data: readonly RewardListItem[];
  readonly meta: { readonly page: number; readonly pageSize: number; readonly total: number };
}

/** The root key every `/rewards` query hangs off, so a mutation can invalidate all of it at once. */
export const REWARDS_ROOT_KEY = ['rewards'] as const;

export function rewardsQueryKey(
  params: RewardListParams = {},
): readonly [string, RewardListParams] {
  return ['rewards', params] as const;
}

export async function fetchRewards(params: RewardListParams): Promise<RewardListResult> {
  try {
    const response = await api.get<unknown>('/rewards', { params });
    const parsed = rewardListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Rewards list response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useRewardsQuery(
  params: RewardListParams = {},
): UseQueryResult<RewardListResult, ReturnType<typeof toApiError>> {
  return useQuery({ queryKey: rewardsQueryKey(params), queryFn: () => fetchRewards(params) });
}

export function rewardQueryKey(id: number): readonly [string, number] {
  return ['rewards', id] as const;
}

export async function fetchReward(id: number): Promise<Reward> {
  try {
    const response = await api.get<unknown>(`/rewards/${String(id)}`);
    const parsed = rewardEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Reward response did not match the expected shape: ${parsed.error.message}`);
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useRewardQuery(id: number) {
  return useQuery({ queryKey: rewardQueryKey(id), queryFn: () => fetchReward(id) });
}

export function rewardCountriesQueryKey(id: number): readonly [string, number, string] {
  return ['rewards', id, 'countries'] as const;
}

export async function fetchRewardCountries(
  id: number,
): Promise<readonly RewardCountryAssignment[]> {
  try {
    const response = await api.get<unknown>(`/rewards/${String(id)}/countries`);
    const parsed = rewardCountryAssignmentListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Reward country assignments response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useRewardCountriesQuery(id: number) {
  return useQuery({
    queryKey: rewardCountriesQueryKey(id),
    queryFn: () => fetchRewardCountries(id),
  });
}

export async function createReward(input: CreateRewardRequest): Promise<Reward> {
  try {
    const payload = createRewardRequestSchema.parse(input);
    const response = await api.post<unknown>('/rewards', payload);
    const parsed = rewardEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-reward response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCreateRewardMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createReward,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: REWARDS_ROOT_KEY });
    },
  });
}

export async function updateReward(id: number, input: UpdateRewardRequest): Promise<Reward> {
  try {
    const payload = updateRewardRequestSchema.parse(input);
    const response = await api.patch<unknown>(`/rewards/${String(id)}`, payload);
    const parsed = rewardEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Update-reward response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useUpdateRewardMutation(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateRewardRequest) => updateReward(id, input),
    onSuccess: (reward) => {
      queryClient.setQueryData(rewardQueryKey(id), reward);
      void queryClient.invalidateQueries({ queryKey: REWARDS_ROOT_KEY });
    },
  });
}

export async function deleteReward(id: number): Promise<void> {
  try {
    await api.delete(`/rewards/${String(id)}`);
  } catch (error) {
    throw toApiError(error);
  }
}

export function useDeleteRewardMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteReward,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: REWARDS_ROOT_KEY });
    },
  });
}

export async function assignRewardCountry(
  rewardId: number,
  input: AssignRewardCountryRequest,
): Promise<RewardCountryAssignment> {
  try {
    const payload = assignRewardCountryRequestSchema.parse(input);
    const response = await api.post<unknown>(`/rewards/${String(rewardId)}/countries`, payload);
    const parsed = rewardCountryAssignmentEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Assign-reward-country response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useAssignRewardCountryMutation(rewardId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AssignRewardCountryRequest) => assignRewardCountry(rewardId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: rewardCountriesQueryKey(rewardId) });
    },
  });
}

export async function unassignRewardCountry(rewardId: number, countryId: number): Promise<void> {
  try {
    await api.delete(`/rewards/${String(rewardId)}/countries/${String(countryId)}`);
  } catch (error) {
    throw toApiError(error);
  }
}

export function useUnassignRewardCountryMutation(rewardId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (countryId: number) => unassignRewardCountry(rewardId, countryId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: rewardCountriesQueryKey(rewardId) });
    },
  });
}

// --- reward_policies (super_admin only) -------------------------------------------------------

export function rewardPoliciesQueryKey(rewardId: number): readonly [string, number, string] {
  return ['rewards', rewardId, 'policies'] as const;
}

export async function fetchRewardPolicies(rewardId: number): Promise<readonly RewardPolicy[]> {
  try {
    const response = await api.get<unknown>(`/rewards/${String(rewardId)}/policies`);
    const parsed = rewardPolicyListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Reward policies response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useRewardPoliciesQuery(rewardId: number) {
  return useQuery({
    queryKey: rewardPoliciesQueryKey(rewardId),
    queryFn: () => fetchRewardPolicies(rewardId),
  });
}

export async function createRewardPolicy(
  rewardId: number,
  input: CreateRewardPolicyRequest,
): Promise<RewardPolicy> {
  try {
    const payload = createRewardPolicyRequestSchema.parse(input);
    const response = await api.post<unknown>(`/rewards/${String(rewardId)}/policies`, payload);
    const parsed = rewardPolicyEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-reward-policy response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCreateRewardPolicyMutation(rewardId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRewardPolicyRequest) => createRewardPolicy(rewardId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: rewardPoliciesQueryKey(rewardId) });
    },
  });
}

export async function updateRewardPolicy(
  rewardId: number,
  policyId: number,
  input: UpdateRewardPolicyRequest,
): Promise<RewardPolicy> {
  try {
    const payload = updateRewardPolicyRequestSchema.parse(input);
    const response = await api.patch<unknown>(
      `/rewards/${String(rewardId)}/policies/${String(policyId)}`,
      payload,
    );
    const parsed = rewardPolicyEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Update-reward-policy response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useUpdateRewardPolicyMutation(rewardId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ policyId, input }: { policyId: number; input: UpdateRewardPolicyRequest }) =>
      updateRewardPolicy(rewardId, policyId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: rewardPoliciesQueryKey(rewardId) });
    },
  });
}
