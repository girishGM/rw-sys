/**
 * T-031 — the `/rules`, `/rule-categories` and `/rule-sub-categories` calls, following the
 * shape `features/countries/api.ts` (T-030) establishes: `lib/apiClient.ts`'s shared `api`
 * instance, and every response parsed through the matching `packages/shared/src/rule.schema.ts`
 * schema — not just cast — so a server/SPA contract drift surfaces as a caught, reported error
 * on this feature rather than as a silent `undefined` deep in a form.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  assignRuleCountryRequestSchema,
  createRuleRequestSchema,
  ruleCategoryListEnvelopeSchema,
  ruleCountryAssignmentEnvelopeSchema,
  ruleCountryAssignmentListEnvelopeSchema,
  ruleEnvelopeSchema,
  ruleListEnvelopeSchema,
  ruleParametersEnvelopeSchema,
  ruleSubCategoryListEnvelopeSchema,
  updateRuleRequestSchema,
  type AssignRuleCountryRequest,
  type CreateRuleRequest,
  type Rule,
  type RuleCategory,
  type RuleCountryAssignment,
  type RuleParameters,
  type RuleSubCategory,
  type UpdateRuleRequest,
} from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { toApiError } from '../../lib/apiError';

export interface RuleListParams {
  readonly page?: number;
  readonly pageSize?: number;
  readonly status?: string;
  readonly sort?: string;
}

export interface RuleListResult {
  readonly data: readonly Rule[];
  readonly meta: { readonly page: number; readonly pageSize: number; readonly total: number };
}

/** The root key every `/rules` query hangs off, so a mutation can invalidate all of it at once. */
export const RULES_ROOT_KEY = ['rules'] as const;

export function rulesQueryKey(params: RuleListParams = {}): readonly [string, RuleListParams] {
  return ['rules', params] as const;
}

export async function fetchRules(params: RuleListParams): Promise<RuleListResult> {
  try {
    const response = await api.get<unknown>('/rules', { params });
    const parsed = ruleListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Rules list response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useRulesQuery(
  params: RuleListParams = {},
): UseQueryResult<RuleListResult, ReturnType<typeof toApiError>> {
  return useQuery({ queryKey: rulesQueryKey(params), queryFn: () => fetchRules(params) });
}

export function ruleQueryKey(id: number): readonly [string, number] {
  return ['rules', id] as const;
}

export async function fetchRule(id: number): Promise<Rule> {
  try {
    const response = await api.get<unknown>(`/rules/${String(id)}`);
    const parsed = ruleEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Rule response did not match the expected shape: ${parsed.error.message}`);
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useRuleQuery(id: number) {
  return useQuery({ queryKey: ruleQueryKey(id), queryFn: () => fetchRule(id) });
}

export function ruleParametersQueryKey(id: number): readonly [string, number, string] {
  return ['rules', id, 'parameters'] as const;
}

export async function fetchRuleParameters(id: number): Promise<RuleParameters> {
  try {
    const response = await api.get<unknown>(`/rules/${String(id)}/parameters`);
    const parsed = ruleParametersEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Rule parameters response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useRuleParametersQuery(id: number) {
  return useQuery({
    queryKey: ruleParametersQueryKey(id),
    queryFn: () => fetchRuleParameters(id),
  });
}

export function ruleCountriesQueryKey(id: number): readonly [string, number, string] {
  return ['rules', id, 'countries'] as const;
}

export async function fetchRuleCountries(id: number): Promise<readonly RuleCountryAssignment[]> {
  try {
    const response = await api.get<unknown>(`/rules/${String(id)}/countries`);
    const parsed = ruleCountryAssignmentListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Rule country assignments response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useRuleCountriesQuery(id: number) {
  return useQuery({
    queryKey: ruleCountriesQueryKey(id),
    queryFn: () => fetchRuleCountries(id),
  });
}

export async function createRule(input: CreateRuleRequest): Promise<Rule> {
  try {
    const payload = createRuleRequestSchema.parse(input);
    const response = await api.post<unknown>('/rules', payload);
    const parsed = ruleEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-rule response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCreateRuleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createRule,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RULES_ROOT_KEY });
    },
  });
}

export async function updateRule(id: number, input: UpdateRuleRequest): Promise<Rule> {
  try {
    const payload = updateRuleRequestSchema.parse(input);
    const response = await api.patch<unknown>(`/rules/${String(id)}`, payload);
    const parsed = ruleEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Update-rule response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useUpdateRuleMutation(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateRuleRequest) => updateRule(id, input),
    onSuccess: (rule) => {
      queryClient.setQueryData(ruleQueryKey(id), rule);
      void queryClient.invalidateQueries({ queryKey: RULES_ROOT_KEY });
    },
  });
}

export async function deleteRule(id: number): Promise<void> {
  try {
    await api.delete(`/rules/${String(id)}`);
  } catch (error) {
    throw toApiError(error);
  }
}

export function useDeleteRuleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteRule,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RULES_ROOT_KEY });
    },
  });
}

export async function assignRuleCountry(
  ruleId: number,
  input: AssignRuleCountryRequest,
): Promise<RuleCountryAssignment> {
  try {
    const payload = assignRuleCountryRequestSchema.parse(input);
    const response = await api.post<unknown>(`/rules/${String(ruleId)}/countries`, payload);
    const parsed = ruleCountryAssignmentEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Assign-rule-country response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useAssignRuleCountryMutation(ruleId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AssignRuleCountryRequest) => assignRuleCountry(ruleId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ruleCountriesQueryKey(ruleId) });
    },
  });
}

export async function unassignRuleCountry(ruleId: number, countryId: number): Promise<void> {
  try {
    await api.delete(`/rules/${String(ruleId)}/countries/${String(countryId)}`);
  } catch (error) {
    throw toApiError(error);
  }
}

export function useUnassignRuleCountryMutation(ruleId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (countryId: number) => unassignRuleCountry(ruleId, countryId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ruleCountriesQueryKey(ruleId) });
    },
  });
}

// --- reference data --------------------------------------------------------------------------

export async function fetchRuleCategories(): Promise<readonly RuleCategory[]> {
  try {
    const response = await api.get<unknown>('/rule-categories');
    const parsed = ruleCategoryListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Rule categories response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useRuleCategoriesQuery() {
  return useQuery({ queryKey: ['rule-categories'], queryFn: fetchRuleCategories });
}

export async function fetchRuleSubCategories(
  categoryId?: number,
): Promise<readonly RuleSubCategory[]> {
  try {
    const response = await api.get<unknown>('/rule-sub-categories', {
      params: categoryId === undefined ? {} : { categoryId },
    });
    const parsed = ruleSubCategoryListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Rule sub-categories response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useRuleSubCategoriesQuery(categoryId?: number) {
  return useQuery({
    queryKey: ['rule-sub-categories', categoryId ?? null],
    queryFn: () => fetchRuleSubCategories(categoryId),
  });
}
