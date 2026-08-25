/**
 * T-041 — the `/blasts` calls, following the shape `features/versions/api.ts` establishes.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  blastEnvelopeSchema,
  blastListEnvelopeSchema,
  blastPreviewEnvelopeSchema,
  createBlastRequestSchema,
  previewBlastRequestSchema,
  type Blast,
  type BlastPreviewResponse,
  type CreateBlastRequest,
  type PreviewBlastRequest,
} from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { toApiError } from '../../lib/apiError';

export interface BlastListParams {
  readonly page?: number;
  readonly pageSize?: number;
  readonly entityType?: 'rule' | 'reward';
  readonly entityId?: number;
}

export interface BlastListResult {
  readonly data: readonly Blast[];
  readonly meta: { readonly page: number; readonly pageSize: number; readonly total: number };
}

export const BLASTS_ROOT_KEY = ['blasts'] as const;

export function blastsQueryKey(params: BlastListParams = {}): readonly [string, BlastListParams] {
  return ['blasts', params] as const;
}

export async function fetchBlasts(params: BlastListParams = {}): Promise<BlastListResult> {
  try {
    const response = await api.get<unknown>('/blasts', { params });
    const parsed = blastListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Blasts list response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useBlastsQuery(params: BlastListParams = {}, enabled = true) {
  return useQuery({
    queryKey: blastsQueryKey(params),
    queryFn: () => fetchBlasts(params),
    enabled,
  });
}

export function blastQueryKey(id: number): readonly [string, number] {
  return ['blasts', id] as const;
}

export async function fetchBlast(id: number): Promise<Blast> {
  try {
    const response = await api.get<unknown>(`/blasts/${String(id)}`);
    const parsed = blastEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Blast response did not match the expected shape: ${parsed.error.message}`);
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useBlastQuery(id: number) {
  return useQuery({ queryKey: blastQueryKey(id), queryFn: () => fetchBlast(id) });
}

export async function previewBlast(input: PreviewBlastRequest): Promise<BlastPreviewResponse> {
  try {
    const payload = previewBlastRequestSchema.parse(input);
    const response = await api.post<unknown>('/blasts/preview', payload);
    const parsed = blastPreviewEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Preview response did not match the expected shape: ${parsed.error.message}`);
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function usePreviewBlastMutation() {
  return useMutation({ mutationFn: previewBlast });
}

export async function createBlast(input: CreateBlastRequest): Promise<Blast> {
  try {
    const payload = createBlastRequestSchema.parse(input);
    const response = await api.post<unknown>('/blasts', payload);
    const parsed = blastEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-blast response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCreateBlastMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createBlast,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BLASTS_ROOT_KEY });
      // A blast also changes what `/rules/:id/versions`/`/countries/:id/assigned-versions`
      // report (superseded/active flips) — invalidate broadly rather than tracking every key.
      void queryClient.invalidateQueries({ queryKey: ['versions'] });
      void queryClient.invalidateQueries({ queryKey: ['countries'] });
    },
  });
}

export type { Blast, BlastPreviewResponse, BlastPreviewCountryImpact } from '@reward-portal/shared';
