/**
 * T-034 — the `/tenants` calls, following the shape `features/countries/api.ts` (T-030)
 * establishes: `lib/apiClient.ts`'s shared `api` instance, and every response parsed through the
 * matching `packages/shared/src/tenant.schema.ts` schema — not just cast — so a server/SPA
 * contract drift surfaces as a caught, reported error on this feature rather than as a silent
 * `undefined` deep in a form.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  budgetCeilingListEnvelopeSchema,
  createTenantEnvelopeSchema,
  tenantAdminCreatedEnvelopeSchema,
  tenantEnvelopeSchema,
  tenantListEnvelopeSchema,
  tenantWithoutCeilingListEnvelopeSchema,
  type BudgetCeiling,
  type CreateTenantAdminRequest,
  type CreateTenantRequest,
  type CreateTenantResponse,
  type Tenant,
  type TenantAdminCreated,
  type TenantWithoutCeiling,
  type UpdateTenantRequest,
  type UpsertBudgetCeilingRequest,
} from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { toApiError } from '../../lib/apiError';

export interface TenantListParams {
  readonly page?: number;
  readonly pageSize?: number;
  readonly sort?: string;
}

export interface TenantListResult {
  readonly data: readonly Tenant[];
  readonly meta: { readonly page: number; readonly pageSize: number; readonly total: number };
}

/** The root key every `/tenants` query hangs off, so a mutation can invalidate all of it at once. */
export const TENANTS_ROOT_KEY = ['tenants'] as const;

export function tenantsQueryKey(
  params: TenantListParams = {},
): readonly [string, TenantListParams] {
  return ['tenants', params] as const;
}

export async function fetchTenants(params: TenantListParams): Promise<TenantListResult> {
  try {
    const response = await api.get<unknown>('/tenants', { params });
    const parsed = tenantListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Tenants list response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useTenantsQuery(
  params: TenantListParams = {},
): UseQueryResult<TenantListResult, ReturnType<typeof toApiError>> {
  return useQuery({
    queryKey: tenantsQueryKey(params),
    queryFn: () => fetchTenants(params),
  });
}

export function tenantQueryKey(id: number): readonly [string, number] {
  return ['tenants', id] as const;
}

export async function fetchTenant(id: number): Promise<Tenant> {
  try {
    const response = await api.get<unknown>(`/tenants/${String(id)}`);
    const parsed = tenantEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Tenant response did not match the expected shape: ${parsed.error.message}`);
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useTenantQuery(id: number) {
  return useQuery({ queryKey: tenantQueryKey(id), queryFn: () => fetchTenant(id) });
}

export async function createTenant(input: CreateTenantRequest): Promise<CreateTenantResponse> {
  try {
    const response = await api.post<unknown>('/tenants', input);
    const parsed = createTenantEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-tenant response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCreateTenantMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createTenant,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TENANTS_ROOT_KEY });
    },
  });
}

export async function createTenantAdmin(
  tenantId: number,
  input: CreateTenantAdminRequest,
): Promise<TenantAdminCreated> {
  try {
    const response = await api.post<unknown>(`/tenants/${String(tenantId)}/admins`, input);
    const parsed = tenantAdminCreatedEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-tenant-admin response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCreateTenantAdminMutation(tenantId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTenantAdminRequest) => createTenantAdmin(tenantId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tenantQueryKey(tenantId) });
    },
  });
}

export async function activateTenant(id: number): Promise<Tenant> {
  try {
    const response = await api.post<unknown>(`/tenants/${String(id)}/activate`, {});
    const parsed = tenantEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Activate-tenant response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useActivateTenantMutation(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => activateTenant(id),
    onSuccess: (tenant) => {
      queryClient.setQueryData(tenantQueryKey(id), tenant);
      void queryClient.invalidateQueries({ queryKey: TENANTS_ROOT_KEY });
    },
  });
}

export async function updateTenant(id: number, input: UpdateTenantRequest): Promise<Tenant> {
  try {
    const response = await api.patch<unknown>(`/tenants/${String(id)}`, input);
    const parsed = tenantEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Update-tenant response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useUpdateTenantMutation(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTenantRequest) => updateTenant(id, input),
    onSuccess: (tenant) => {
      queryClient.setQueryData(tenantQueryKey(id), tenant);
      void queryClient.invalidateQueries({ queryKey: TENANTS_ROOT_KEY });
    },
  });
}

export function budgetCeilingsQueryKey(tenantId: number): readonly [string, number, string] {
  return ['tenants', tenantId, 'budget-ceilings'] as const;
}

export async function fetchBudgetCeilings(tenantId: number): Promise<readonly BudgetCeiling[]> {
  try {
    const response = await api.get<unknown>(`/tenants/${String(tenantId)}/budget-ceilings`);
    const parsed = budgetCeilingListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Budget-ceilings response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useBudgetCeilingsQuery(tenantId: number) {
  return useQuery({
    queryKey: budgetCeilingsQueryKey(tenantId),
    queryFn: () => fetchBudgetCeilings(tenantId),
  });
}

export async function upsertBudgetCeiling(
  tenantId: number,
  input: UpsertBudgetCeilingRequest,
): Promise<readonly BudgetCeiling[]> {
  try {
    const response = await api.put<unknown>(`/tenants/${String(tenantId)}/budget-ceilings`, input);
    const parsed = budgetCeilingListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Upsert-budget-ceiling response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useUpsertBudgetCeilingMutation(tenantId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertBudgetCeilingRequest) => upsertBudgetCeiling(tenantId, input),
    onSuccess: (rows) => {
      queryClient.setQueryData(budgetCeilingsQueryKey(tenantId), rows);
    },
  });
}

/** Implementation note 7 / TC-28 — the Country Admin dashboard widget's data source. See
 * `TenantsWithoutCeilingWidget.tsx`'s own header for why this is not wired into the generic
 * `/dashboard/widgets/:widgetKey` route T-023 registered `list_tenants_without_ceiling` under. */
export const TENANTS_WITHOUT_CEILING_QUERY_KEY = ['tenants', 'without-budget-ceiling'] as const;

export async function fetchTenantsWithoutCeiling(): Promise<readonly TenantWithoutCeiling[]> {
  try {
    const response = await api.get<unknown>('/tenants/without-budget-ceiling');
    const parsed = tenantWithoutCeilingListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Tenants-without-ceiling response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useTenantsWithoutCeilingQuery() {
  return useQuery({
    queryKey: TENANTS_WITHOUT_CEILING_QUERY_KEY,
    queryFn: fetchTenantsWithoutCeiling,
  });
}
