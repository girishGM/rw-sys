/**
 * T-030 — the `/countries` calls, following the shape `features/trace/api.ts` (T-045)
 * establishes: `lib/apiClient.ts`'s shared `api` instance, and every response parsed through the
 * matching `packages/shared/src/country.schema.ts` schema — not just cast — so a server/SPA
 * contract drift surfaces as a caught, reported error on this feature rather than as a silent
 * `undefined` deep in a form.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  countryAdminCreatedEnvelopeSchema,
  countryEnvelopeSchema,
  countryListEnvelopeSchema,
  countrySummaryEnvelopeSchema,
  createCountryEnvelopeSchema,
  type Country,
  type CountryAdminCreated,
  type CountrySummary,
  type CreateCountryAdminRequest,
  type CreateCountryRequest,
  type CreateCountryResponse,
  type UpdateCountryRequest,
} from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { toApiError } from '../../lib/apiError';

export interface CountryListParams {
  readonly page?: number;
  readonly pageSize?: number;
  readonly sort?: string;
}

export interface CountryListResult {
  readonly data: readonly Country[];
  readonly meta: { readonly page: number; readonly pageSize: number; readonly total: number };
}

/** The root key every `/countries` query hangs off, so a mutation can invalidate all of it at once. */
export const COUNTRIES_ROOT_KEY = ['countries'] as const;

export function countriesQueryKey(
  params: CountryListParams = {},
): readonly [string, CountryListParams] {
  return ['countries', params] as const;
}

export async function fetchCountries(params: CountryListParams): Promise<CountryListResult> {
  try {
    const response = await api.get<unknown>('/countries', { params });
    const parsed = countryListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Countries list response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCountriesQuery(
  params: CountryListParams = {},
): UseQueryResult<CountryListResult, ReturnType<typeof toApiError>> {
  return useQuery({
    queryKey: countriesQueryKey(params),
    queryFn: () => fetchCountries(params),
  });
}

export function countryQueryKey(id: number): readonly [string, number] {
  return ['countries', id] as const;
}

export async function fetchCountry(id: number): Promise<Country> {
  try {
    const response = await api.get<unknown>(`/countries/${String(id)}`);
    const parsed = countryEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Country response did not match the expected shape: ${parsed.error.message}`);
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCountryQuery(id: number) {
  return useQuery({ queryKey: countryQueryKey(id), queryFn: () => fetchCountry(id) });
}

export function countrySummaryQueryKey(id: number): readonly [string, number, string] {
  return ['countries', id, 'summary'] as const;
}

export async function fetchCountrySummary(id: number): Promise<CountrySummary> {
  try {
    const response = await api.get<unknown>(`/countries/${String(id)}/summary`);
    const parsed = countrySummaryEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Country summary response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCountrySummaryQuery(id: number) {
  return useQuery({
    queryKey: countrySummaryQueryKey(id),
    queryFn: () => fetchCountrySummary(id),
  });
}

export async function createCountry(input: CreateCountryRequest): Promise<CreateCountryResponse> {
  try {
    const response = await api.post<unknown>('/countries', input);
    const parsed = createCountryEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-country response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCreateCountryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createCountry,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: COUNTRIES_ROOT_KEY });
    },
  });
}

export async function createCountryAdmin(
  countryId: number,
  input: CreateCountryAdminRequest,
): Promise<CountryAdminCreated> {
  try {
    const response = await api.post<unknown>(`/countries/${String(countryId)}/admins`, input);
    const parsed = countryAdminCreatedEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-country-admin response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCreateCountryAdminMutation(countryId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCountryAdminRequest) => createCountryAdmin(countryId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: countryQueryKey(countryId) });
    },
  });
}

export async function updateCountry(id: number, input: UpdateCountryRequest): Promise<Country> {
  try {
    const response = await api.patch<unknown>(`/countries/${String(id)}`, input);
    const parsed = countryEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Update-country response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useUpdateCountryMutation(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateCountryRequest) => updateCountry(id, input),
    onSuccess: (country) => {
      queryClient.setQueryData(countryQueryKey(id), country);
      void queryClient.invalidateQueries({ queryKey: COUNTRIES_ROOT_KEY });
      void queryClient.invalidateQueries({ queryKey: countrySummaryQueryKey(id) });
    },
  });
}
