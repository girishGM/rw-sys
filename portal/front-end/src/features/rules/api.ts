/**
 * T-031 — the `/rules`, `/rule-categories` and `/rule-sub-categories` calls, following the
 * shape `features/countries/api.ts` (T-030) establishes: `lib/apiClient.ts`'s shared `api`
 * instance, and every response parsed through the matching `packages/shared/src/rule.schema.ts`
 * schema — not just cast — so a server/SPA contract drift surfaces as a caught, reported error
 * on this feature rather than as a silent `undefined` deep in a form.
 */
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  assignRuleCountryRequestSchema,
  createFieldApiLookupProviderRequestSchema,
  createFieldContextProviderRequestSchema,
  createRuleCategoryRequestSchema,
  createRuleRequestSchema,
  createRuleSubCategoryRequestSchema,
  fieldApiLookupProviderEnvelopeSchema,
  fieldApiLookupProviderListEnvelopeSchema,
  fieldContextProviderEnvelopeSchema,
  fieldContextProviderListEnvelopeSchema,
  ruleCategoryEnvelopeSchema,
  ruleCategoryListEnvelopeSchema,
  ruleCountryAssignmentEnvelopeSchema,
  ruleCountryAssignmentListEnvelopeSchema,
  ruleEnvelopeSchema,
  ruleOperatorListEnvelopeSchema,
  ruleParametersEnvelopeSchema,
  ruleResolverListEnvelopeSchema,
  ruleSchema,
  ruleSubCategoryEnvelopeSchema,
  ruleSubCategoryListEnvelopeSchema,
  updateFieldApiLookupProviderRequestSchema,
  updateFieldContextProviderRequestSchema,
  updateRuleCategoryRequestSchema,
  updateRuleRequestSchema,
  updateRuleSubCategoryRequestSchema,
  type AssignRuleCountryRequest,
  type CreateFieldApiLookupProviderRequest,
  type CreateFieldContextProviderRequest,
  type CreateRuleCategoryRequest,
  type CreateRuleRequest,
  type CreateRuleSubCategoryRequest,
  type FieldApiLookupProvider,
  type FieldContextProvider,
  type Rule,
  type RuleCategory,
  type RuleCountryAssignment,
  type RuleOperator,
  type RuleParameters,
  type RuleResolver,
  type RuleSubCategory,
  type UpdateFieldApiLookupProviderRequest,
  type UpdateFieldContextProviderRequest,
  type UpdateRuleCategoryRequest,
  type UpdateRuleRequest,
  type UpdateRuleSubCategoryRequest,
} from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { toApiError } from '../../lib/apiError';

export interface RuleListParams {
  readonly page?: number;
  readonly pageSize?: number;
  readonly status?: string;
  readonly sort?: string;
  /** T-111 — rules whose sub-category rolls up to this category. */
  readonly categoryId?: number;
  /** T-111 — exact sub-category match; wins over `categoryId` when both are set. */
  readonly subCategoryId?: number;
  /** T-111 — plain-text match against `ruleCode`/`name`, case-insensitive. */
  readonly search?: string;
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

/**
 * T-159 — the envelope's own shape, `ruleSchema` deliberately excluded (below). `.strict()`, same
 * discipline the shared package's own `ruleListEnvelopeSchema` applies: a genuinely malformed
 * response (wrong content-type, `data` not an array, `meta` missing/reshaped) still fails here
 * exactly as it always has.
 */
const ruleListResponseShapeSchema = z
  .object({
    data: z.array(z.unknown()),
    meta: z
      .object({ page: z.number().int(), pageSize: z.number().int(), total: z.number().int() })
      .strict(),
  })
  .strict();

/**
 * T-159 — root-caused live against the real dev database: `GET /rules`'s read paths
 * intentionally never reject a legacy `rule_master.parameters` blob
 * (`rule-master.model.ts`'s "never throws" getter, `rules.service.ts`'s own header), but the
 * *shared*, `.strict()` `ruleSchema` this file used to validate the whole page against in one
 * shot is deliberately **stricter** — T-122's `valueSourceOnlyOnSelect` refinement exists
 * specifically to reject a `valueSource` on a non-`select` field (tested directly against
 * `ruleParameterFieldWithRoleSchema` in `rule.schema.spec.ts`), and is not something this task
 * may weaken (AGENT-PROTOCOL §7 — "never weaken a guard to make a test green"). Reproduced live:
 * `rule_master.id=1790` (`ruleCode: 'T037E2E_RULE_SIBLING'`), a leftover row predating that
 * refinement, carries a `type: 'string'` field with a `valueSource` — invalid under today's
 * rules, but still exactly what the server honestly has stored and honestly returns. Sorted by
 * `name:asc` with the default `pageSize` of 20, that one row lands on page 2 of 3, so the old
 * single `ruleListEnvelopeSchema.safeParse(response.data)` — which validated the whole `data`
 * array as one unit — failed for the **entire page**, not just that row, on every "Next" click
 * past page 1. This is the same class of bug T-074's own comment on this schema already names
 * ("one bad row must not break the whole list"), reproduced one layer up: this file's own
 * `fetchRule`/`fetchRuleParameters` single-row reads are unaffected by this fix (a legacy row
 * that fails still 404s from the campaign wizard's point of view rather than crashing everyone
 * else's list — no worse than before this fix, and out of T-159's "Next" pagination scope).
 *
 * The fix mirrors T-074's shape but applies at the row level instead of a single normalised
 * field: {@link ruleListResponseShapeSchema} still validates the envelope strictly, but each row
 * of `data` is now validated **independently** against `ruleSchema`. A row that fails is dropped,
 * logged (`console.error` — this is data the write path can no longer produce since T-122, so
 * every occurrence is a legacy artifact worth a human's attention) and excluded from the page;
 * every other row on that page, and every other page, is unaffected. `meta` is returned exactly
 * as the server reported it — never patched down to the post-drop row count — so
 * `RulesListPage.tsx`'s pager (driven entirely by `meta.page`/`meta.pageSize`/`meta.total`, per
 * that file's own header) keeps counting and paging correctly regardless of how many rows on a
 * given page were dropped.
 */
export async function fetchRules(params: RuleListParams): Promise<RuleListResult> {
  try {
    const response = await api.get<unknown>('/rules', { params });
    const shape = ruleListResponseShapeSchema.safeParse(response.data);
    if (!shape.success) {
      throw new Error(
        `Rules list response did not match the expected shape: ${shape.error.message}`,
      );
    }

    const rows: Rule[] = [];
    shape.data.data.forEach((row, index) => {
      const parsedRow = ruleSchema.safeParse(row);
      if (parsedRow.success) {
        rows.push(parsedRow.data);
      } else {
        console.error(
          `Rules list row ${String(index)} did not match the shared schema and was dropped: ${parsedRow.error.message}`,
        );
      }
    });

    return { data: rows, meta: shape.data.meta };
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

// --- T-106: category / sub-category CRUD -----------------------------------------------------

export async function createRuleCategory(input: CreateRuleCategoryRequest): Promise<RuleCategory> {
  try {
    const payload = createRuleCategoryRequestSchema.parse(input);
    const response = await api.post<unknown>('/rule-categories', payload);
    const parsed = ruleCategoryEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-rule-category response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCreateRuleCategoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createRuleCategory,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rule-categories'] });
    },
  });
}

export async function updateRuleCategory(
  id: number,
  input: UpdateRuleCategoryRequest,
): Promise<RuleCategory> {
  try {
    const payload = updateRuleCategoryRequestSchema.parse(input);
    const response = await api.patch<unknown>(`/rule-categories/${String(id)}`, payload);
    const parsed = ruleCategoryEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Update-rule-category response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useUpdateRuleCategoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: UpdateRuleCategoryRequest }) =>
      updateRuleCategory(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rule-categories'] });
    },
  });
}

export async function createRuleSubCategory(
  input: CreateRuleSubCategoryRequest,
): Promise<RuleSubCategory> {
  try {
    const payload = createRuleSubCategoryRequestSchema.parse(input);
    const response = await api.post<unknown>('/rule-sub-categories', payload);
    const parsed = ruleSubCategoryEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-rule-sub-category response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCreateRuleSubCategoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createRuleSubCategory,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rule-sub-categories'] });
    },
  });
}

export async function updateRuleSubCategory(
  id: number,
  input: UpdateRuleSubCategoryRequest,
): Promise<RuleSubCategory> {
  try {
    const payload = updateRuleSubCategoryRequestSchema.parse(input);
    const response = await api.patch<unknown>(`/rule-sub-categories/${String(id)}`, payload);
    const parsed = ruleSubCategoryEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Update-rule-sub-category response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useUpdateRuleSubCategoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: UpdateRuleSubCategoryRequest }) =>
      updateRuleSubCategory(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rule-sub-categories'] });
    },
  });
}

// --- T-108: registries (read-only) ------------------------------------------------------------

export async function fetchRuleResolvers(): Promise<readonly RuleResolver[]> {
  try {
    const response = await api.get<unknown>('/rule-resolvers');
    const parsed = ruleResolverListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Rule resolvers response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useRuleResolversQuery() {
  return useQuery({ queryKey: ['rule-resolvers'], queryFn: fetchRuleResolvers });
}

export async function fetchRuleOperators(): Promise<readonly RuleOperator[]> {
  try {
    const response = await api.get<unknown>('/rule-operators');
    const parsed = ruleOperatorListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Rule operators response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useRuleOperatorsQuery() {
  return useQuery({ queryKey: ['rule-operators'], queryFn: fetchRuleOperators });
}

// --- T-125: field value-source registries (read-only) ------------------------------------------
//
// Feeds the field builder's "Where do the options come from?" picker (`ParameterFieldsEditor`):
// `GET /field-context-providers` for the "This journey" choice, `GET /field-api-lookup-providers`
// for "Live lookup" — both T-121, every role may read them (13-REWARD-MASTER-VALUE-SOURCES.md §3).

export async function fetchFieldContextProviders(): Promise<readonly FieldContextProvider[]> {
  try {
    const response = await api.get<unknown>('/field-context-providers');
    const parsed = fieldContextProviderListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Field context providers response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

/** The root key every `field-context-providers` query hangs off (mirrors `RULES_ROOT_KEY`). */
export const FIELD_CONTEXT_PROVIDERS_ROOT_KEY = ['field-context-providers'] as const;

export function useFieldContextProvidersQuery() {
  return useQuery({
    queryKey: FIELD_CONTEXT_PROVIDERS_ROOT_KEY,
    queryFn: fetchFieldContextProviders,
  });
}

// --- T-162: value-source registries write endpoints (T-121 already built and gated them;
// this task only adds the mutation hooks that call them) -------------------------------------

export async function createFieldContextProvider(
  input: CreateFieldContextProviderRequest,
): Promise<FieldContextProvider> {
  try {
    const payload = createFieldContextProviderRequestSchema.parse(input);
    const response = await api.post<unknown>('/field-context-providers', payload);
    const parsed = fieldContextProviderEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-field-context-provider response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCreateFieldContextProviderMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createFieldContextProvider,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FIELD_CONTEXT_PROVIDERS_ROOT_KEY });
    },
  });
}

export async function updateFieldContextProvider(
  id: number,
  input: UpdateFieldContextProviderRequest,
): Promise<FieldContextProvider> {
  try {
    const payload = updateFieldContextProviderRequestSchema.parse(input);
    const response = await api.patch<unknown>(`/field-context-providers/${String(id)}`, payload);
    const parsed = fieldContextProviderEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Update-field-context-provider response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useUpdateFieldContextProviderMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: UpdateFieldContextProviderRequest }) =>
      updateFieldContextProvider(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FIELD_CONTEXT_PROVIDERS_ROOT_KEY });
    },
  });
}

export async function fetchFieldApiLookupProviders(): Promise<readonly FieldApiLookupProvider[]> {
  try {
    const response = await api.get<unknown>('/field-api-lookup-providers');
    const parsed = fieldApiLookupProviderListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Field API lookup providers response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

/** The root key every `field-api-lookup-providers` query hangs off. */
export const FIELD_API_LOOKUP_PROVIDERS_ROOT_KEY = ['field-api-lookup-providers'] as const;

export function useFieldApiLookupProvidersQuery() {
  return useQuery({
    queryKey: FIELD_API_LOOKUP_PROVIDERS_ROOT_KEY,
    queryFn: fetchFieldApiLookupProviders,
  });
}

export async function createFieldApiLookupProvider(
  input: CreateFieldApiLookupProviderRequest,
): Promise<FieldApiLookupProvider> {
  try {
    const payload = createFieldApiLookupProviderRequestSchema.parse(input);
    const response = await api.post<unknown>('/field-api-lookup-providers', payload);
    const parsed = fieldApiLookupProviderEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-field-api-lookup-provider response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCreateFieldApiLookupProviderMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createFieldApiLookupProvider,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FIELD_API_LOOKUP_PROVIDERS_ROOT_KEY });
    },
  });
}

export async function updateFieldApiLookupProvider(
  id: number,
  input: UpdateFieldApiLookupProviderRequest,
): Promise<FieldApiLookupProvider> {
  try {
    const payload = updateFieldApiLookupProviderRequestSchema.parse(input);
    const response = await api.patch<unknown>(`/field-api-lookup-providers/${String(id)}`, payload);
    const parsed = fieldApiLookupProviderEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Update-field-api-lookup-provider response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useUpdateFieldApiLookupProviderMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: UpdateFieldApiLookupProviderRequest }) =>
      updateFieldApiLookupProvider(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FIELD_API_LOOKUP_PROVIDERS_ROOT_KEY });
    },
  });
}
