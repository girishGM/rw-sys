/**
 * T-042 — the `/definition-requests` calls, following the shape `features/rules/api.ts`
 * (T-031) establishes: `lib/apiClient.ts`'s shared `api` instance, and every response parsed
 * through the matching `packages/shared/src/definition-request.schema.ts` schema — not just
 * cast — so a server/SPA contract drift surfaces as a caught, reported error on this feature
 * rather than as a silent `undefined` deep in a form.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  createDefinitionRequestSchema,
  definitionRequestEnvelopeSchema,
  definitionRequestListEnvelopeSchema,
  fulfilDefinitionRequestSchema,
  reviewDefinitionRequestSchema,
  updateDefinitionRequestSchema,
  type CreateDefinitionRequestRequest,
  type DefinitionRequest,
  type FulfilDefinitionRequestRequest,
  type ReviewDefinitionRequestRequest,
  type UpdateDefinitionRequestRequest,
} from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { toApiError } from '../../lib/apiError';

export interface DefinitionRequestListParams {
  readonly page?: number;
  readonly pageSize?: number;
  readonly status?: string;
  readonly priority?: string;
}

export interface DefinitionRequestListResult {
  readonly data: readonly DefinitionRequest[];
  readonly meta: { readonly page: number; readonly pageSize: number; readonly total: number };
}

/** The root key every `/definition-requests` query hangs off, so a mutation can invalidate all
 * of it at once. */
export const DEFINITION_REQUESTS_ROOT_KEY = ['definition-requests'] as const;

export function definitionRequestsQueryKey(
  params: DefinitionRequestListParams = {},
): readonly [string, DefinitionRequestListParams] {
  return ['definition-requests', params] as const;
}

export async function fetchDefinitionRequests(
  params: DefinitionRequestListParams,
): Promise<DefinitionRequestListResult> {
  try {
    const response = await api.get<unknown>('/definition-requests', { params });
    const parsed = definitionRequestListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Definition requests list response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useDefinitionRequestsQuery(
  params: DefinitionRequestListParams = {},
): UseQueryResult<DefinitionRequestListResult, ReturnType<typeof toApiError>> {
  return useQuery({
    queryKey: definitionRequestsQueryKey(params),
    queryFn: () => fetchDefinitionRequests(params),
  });
}

export function definitionRequestQueryKey(id: number): readonly [string, number] {
  return ['definition-requests', id] as const;
}

export async function fetchDefinitionRequest(id: number): Promise<DefinitionRequest> {
  try {
    const response = await api.get<unknown>(`/definition-requests/${String(id)}`);
    const parsed = definitionRequestEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Definition request response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useDefinitionRequestQuery(id: number) {
  return useQuery({
    queryKey: definitionRequestQueryKey(id),
    queryFn: () => fetchDefinitionRequest(id),
  });
}

export async function createDefinitionRequest(
  input: CreateDefinitionRequestRequest,
): Promise<DefinitionRequest> {
  try {
    const payload = createDefinitionRequestSchema.parse(input);
    const response = await api.post<unknown>('/definition-requests', payload);
    const parsed = definitionRequestEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-definition-request response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCreateDefinitionRequestMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createDefinitionRequest,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DEFINITION_REQUESTS_ROOT_KEY });
    },
  });
}

export async function updateDefinitionRequest(
  id: number,
  input: UpdateDefinitionRequestRequest,
): Promise<DefinitionRequest> {
  try {
    const payload = updateDefinitionRequestSchema.parse(input);
    const response = await api.patch<unknown>(`/definition-requests/${String(id)}`, payload);
    const parsed = definitionRequestEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Update-definition-request response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useUpdateDefinitionRequestMutation(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateDefinitionRequestRequest) => updateDefinitionRequest(id, input),
    onSuccess: (row) => {
      queryClient.setQueryData(definitionRequestQueryKey(id), row);
      void queryClient.invalidateQueries({ queryKey: DEFINITION_REQUESTS_ROOT_KEY });
    },
  });
}

export async function withdrawDefinitionRequest(id: number): Promise<DefinitionRequest> {
  try {
    const response = await api.post<unknown>(`/definition-requests/${String(id)}/withdraw`);
    const parsed = definitionRequestEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Withdraw-definition-request response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useWithdrawDefinitionRequestMutation(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => withdrawDefinitionRequest(id),
    onSuccess: (row) => {
      queryClient.setQueryData(definitionRequestQueryKey(id), row);
      void queryClient.invalidateQueries({ queryKey: DEFINITION_REQUESTS_ROOT_KEY });
    },
  });
}

export async function reviewDefinitionRequest(
  id: number,
  input: ReviewDefinitionRequestRequest,
): Promise<DefinitionRequest> {
  try {
    const payload = reviewDefinitionRequestSchema.parse(input);
    const response = await api.post<unknown>(`/definition-requests/${String(id)}/review`, payload);
    const parsed = definitionRequestEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Review-definition-request response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useReviewDefinitionRequestMutation(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewDefinitionRequestRequest) => reviewDefinitionRequest(id, input),
    onSuccess: (row) => {
      queryClient.setQueryData(definitionRequestQueryKey(id), row);
      void queryClient.invalidateQueries({ queryKey: DEFINITION_REQUESTS_ROOT_KEY });
    },
  });
}

export async function fulfilDefinitionRequest(
  id: number,
  input: FulfilDefinitionRequestRequest,
): Promise<DefinitionRequest> {
  try {
    const payload = fulfilDefinitionRequestSchema.parse(input);
    const response = await api.post<unknown>(`/definition-requests/${String(id)}/fulfil`, payload);
    const parsed = definitionRequestEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Fulfil-definition-request response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useFulfilDefinitionRequestMutation(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: FulfilDefinitionRequestRequest) => fulfilDefinitionRequest(id, input),
    onSuccess: (row) => {
      queryClient.setQueryData(definitionRequestQueryKey(id), row);
      void queryClient.invalidateQueries({ queryKey: DEFINITION_REQUESTS_ROOT_KEY });
    },
  });
}
