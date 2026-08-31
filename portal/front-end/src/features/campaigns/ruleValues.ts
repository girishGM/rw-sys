/**
 * T-037 — the client-side half of rule-value validation, kept out of `DynamicParameterForm.tsx`.
 *
 * Two reasons, and only the second is about lint. A module that exports both a component and
 * plain functions breaks React Fast Refresh (`react-refresh/only-export-components`), which the
 * workspace treats as an error at `--max-warnings=0`. More usefully, this function is the piece
 * a **caller** wants — the step-4 screen asks "is this rule complete?" without rendering
 * anything — so it belongs beside the component rather than inside it.
 *
 * What it is *not* is a control. `bindings.service.ts` re-validates the same values against the
 * same shared schema server-side (implementation note 9, TC-17); this exists so a maker sees the
 * problem next to the field.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { buildRuleValueSchema, type RuleParameters } from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { ApiError, toApiError } from '../../lib/apiError';

/**
 * The per-field messages `buildRuleValueSchema` produces for `values`, keyed by parameter key.
 *
 * `unrecognized_keys` needs its own branch: Zod reports an extra key on the **object**, with an
 * empty `path`, so a naive `issue.path[0]` mapping silently drops it and the maker sees nothing
 * at all while the server refuses the save (TC-19). The offending keys are on the issue itself,
 * and are surfaced under their own names — which is also the only way to say something useful
 * about a value that has no control to attach it to.
 */
export function validateValues(
  parameters: RuleParameters,
  values: Record<string, unknown>,
): Record<string, string> {
  const result = buildRuleValueSchema(parameters).safeParse(values);
  if (result.success) return {};

  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        errors[key] ??= 'This rule does not accept a value with this name.';
      }
      continue;
    }
    const key = issue.path[0];
    if (typeof key === 'string' && errors[key] === undefined) errors[key] = issue.message;
  }
  return errors;
}

/**
 * T-125 — the two runtime endpoints a `select` field's `valueSource` (T-122) resolves against
 * (`13-REWARD-MASTER-VALUE-SOURCES.md` §3, T-123's own contract). Kept here rather than in
 * `features/campaigns/api.ts` — this file's own `Files owned` does not include that module — and
 * parsed by hand rather than through a shared Zod schema, since neither lookup response has one
 * yet (`packages/shared/src/field-value-source.schema.ts` covers only the two *registries*,
 * T-121, not what T-123's runtime lookups resolve into). What is checked here mirrors exactly
 * what `field-value-source-lookup.service.ts`'s own header documents both endpoints return.
 */
export interface FieldValueOption {
  readonly value: string | number;
  readonly label: string;
}

function isFieldValueOption(value: unknown): value is FieldValueOption {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    (typeof candidate.value === 'string' || typeof candidate.value === 'number') &&
    typeof candidate.label === 'string'
  );
}

function parseFieldValueOptionList(data: unknown): FieldValueOption[] {
  const body = data as { data?: unknown } | null | undefined;
  const list = body?.data;
  if (!Array.isArray(list) || !list.every(isFieldValueOption)) {
    throw new Error(
      'Field value-source lookup response did not match the expected { data: [{ value, label }] } shape',
    );
  }
  return list.map((entry) => ({ value: entry.value, label: entry.label }));
}

/** `GET /field-value-sources/context/:contextProvider` (T-123) — reads the in-progress campaign
 * draft itself, no network call on the server's side. `excludeComponentId` is the requesting
 * component's own id; omitted only for a brand-new, not-yet-saved component (T-123 implementation
 * note 1) — every component this step renders already has one. */
export async function fetchContextLookupOptions(
  contextProvider: string,
  trackerId: number,
  excludeComponentId?: number,
): Promise<FieldValueOption[]> {
  try {
    const response = await api.get<unknown>(`/field-value-sources/context/${contextProvider}`, {
      params: excludeComponentId === undefined ? { trackerId } : { trackerId, excludeComponentId },
    });
    return parseFieldValueOptionList(response.data);
  } catch (error) {
    throw toApiError(error);
  }
}

export function useContextLookupOptions(
  contextProvider: string,
  trackerId: number,
  excludeComponentId: number,
): UseQueryResult<FieldValueOption[], ApiError> {
  return useQuery({
    queryKey: ['field-value-sources', 'context', contextProvider, trackerId, excludeComponentId],
    queryFn: () => fetchContextLookupOptions(contextProvider, trackerId, excludeComponentId),
  });
}

/** `GET /field-value-sources/api/:apiProvider` (T-123) — proxies a registered external endpoint
 * server-side. A `planned` provider answers `501`, surfaced here as an `ApiError` with
 * `status === 501` so the caller can render "not available yet" instead of a spinner that never
 * resolves (implementation note 2) rather than retrying a call that can never succeed. */
export async function fetchApiLookupOptions(apiProvider: string): Promise<FieldValueOption[]> {
  try {
    const response = await api.get<unknown>(`/field-value-sources/api/${apiProvider}`);
    return parseFieldValueOptionList(response.data);
  } catch (error) {
    throw toApiError(error);
  }
}

/** HTTP status T-123's lookup service returns for a `planned`/`inactive` provider — never
 * retried, since the provider's own status (not a transient failure) is why the call is
 * declined. */
export const FIELD_LOOKUP_NOT_AVAILABLE_STATUS = 501;

export function useApiLookupOptions(
  apiProvider: string,
): UseQueryResult<FieldValueOption[], ApiError> {
  return useQuery({
    queryKey: ['field-value-sources', 'api', apiProvider],
    queryFn: () => fetchApiLookupOptions(apiProvider),
    retry: false,
  });
}
