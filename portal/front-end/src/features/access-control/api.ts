/**
 * T-033 — the `/admin/access-control` calls, following the shape `features/rules/api.ts` (T-031)
 * establishes: `lib/apiClient.ts`'s shared `api` instance, and every response parsed through the
 * matching `packages/shared/src/access-control.schema.ts` schema — not just cast — so a
 * server/SPA contract drift surfaces as a caught, reported error on this feature rather than as a
 * silent `undefined` deep in a form.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  entityCatalogueListEnvelopeSchema,
  navConfigEnvelopeSchema,
  permissionsEnvelopeSchema,
  previewEnvelopeSchema,
  putNavConfigRequestSchema,
  putPermissionsRequestSchema,
  putWidgetConfigRequestSchema,
  reorderRequestSchema,
  previewRequestSchema,
  roleSummaryListEnvelopeSchema,
  widgetConfigEnvelopeSchema,
  type EntityCatalogueEntry,
  type NavConfigResponse,
  type PermissionsResponse,
  type PreviewRequest,
  type PreviewResponse,
  type PutNavConfigRequest,
  type PutPermissionsRequest,
  type PutWidgetConfigRequest,
  type ReorderRequest,
  type RoleSummary,
  type SharedPortalRole,
  type WidgetConfigResponse,
} from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { toApiError } from '../../lib/apiError';

const ROOT_KEY = ['access-control'] as const;

/** The root key every `/admin/access-control` query hangs off, so a mutation can invalidate
 * everything at once (used after a nav/permissions/widgets change also invalidates `roles`, since
 * user counts do not change but this keeps behaviour simple and correct rather than clever). */
export const ACCESS_CONTROL_ROOT_KEY = ROOT_KEY;

export async function fetchRoles(): Promise<readonly RoleSummary[]> {
  try {
    const response = await api.get<unknown>('/admin/access-control/roles');
    const parsed = roleSummaryListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Roles response did not match the expected shape: ${parsed.error.message}`);
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useRolesQuery(): UseQueryResult<
  readonly RoleSummary[],
  ReturnType<typeof toApiError>
> {
  return useQuery({ queryKey: [...ROOT_KEY, 'roles'], queryFn: fetchRoles });
}

export async function fetchEntities(): Promise<readonly EntityCatalogueEntry[]> {
  try {
    const response = await api.get<unknown>('/admin/access-control/entities');
    const parsed = entityCatalogueListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Entities response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useEntitiesQuery() {
  return useQuery({ queryKey: [...ROOT_KEY, 'entities'], queryFn: fetchEntities });
}

// --- nav -----------------------------------------------------------------------------------

function navQueryKey(role: SharedPortalRole) {
  return [...ROOT_KEY, 'nav', role] as const;
}

export async function fetchNav(role: SharedPortalRole): Promise<NavConfigResponse> {
  try {
    const response = await api.get<unknown>(`/admin/access-control/nav/${role}`);
    const parsed = navConfigEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Nav response did not match the expected shape: ${parsed.error.message}`);
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useNavQuery(role: SharedPortalRole) {
  return useQuery({ queryKey: navQueryKey(role), queryFn: () => fetchNav(role) });
}

export async function putNav(
  role: SharedPortalRole,
  input: PutNavConfigRequest,
): Promise<NavConfigResponse> {
  try {
    const payload = putNavConfigRequestSchema.parse(input);
    const response = await api.put<unknown>(`/admin/access-control/nav/${role}`, payload);
    const parsed = navConfigEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Nav response did not match the expected shape: ${parsed.error.message}`);
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function usePutNavMutation(role: SharedPortalRole) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PutNavConfigRequest) => putNav(role, input),
    onSuccess: (data) => {
      queryClient.setQueryData(navQueryKey(role), data);
    },
  });
}

export async function reorderNav(
  role: SharedPortalRole,
  input: ReorderRequest,
): Promise<NavConfigResponse> {
  try {
    const payload = reorderRequestSchema.parse(input);
    const response = await api.patch<unknown>(`/admin/access-control/nav/${role}/reorder`, payload);
    const parsed = navConfigEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Nav response did not match the expected shape: ${parsed.error.message}`);
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useReorderNavMutation(role: SharedPortalRole) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ReorderRequest) => reorderNav(role, input),
    onSuccess: (data) => {
      queryClient.setQueryData(navQueryKey(role), data);
    },
  });
}

// --- widgets -------------------------------------------------------------------------------

function widgetsQueryKey(role: SharedPortalRole) {
  return [...ROOT_KEY, 'widgets', role] as const;
}

export async function fetchWidgets(role: SharedPortalRole): Promise<WidgetConfigResponse> {
  try {
    const response = await api.get<unknown>(`/admin/access-control/widgets/${role}`);
    const parsed = widgetConfigEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Widgets response did not match the expected shape: ${parsed.error.message}`);
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useWidgetsQuery(role: SharedPortalRole) {
  return useQuery({ queryKey: widgetsQueryKey(role), queryFn: () => fetchWidgets(role) });
}

export async function putWidgets(
  role: SharedPortalRole,
  input: PutWidgetConfigRequest,
): Promise<WidgetConfigResponse> {
  try {
    const payload = putWidgetConfigRequestSchema.parse(input);
    const response = await api.put<unknown>(`/admin/access-control/widgets/${role}`, payload);
    const parsed = widgetConfigEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Widgets response did not match the expected shape: ${parsed.error.message}`);
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function usePutWidgetsMutation(role: SharedPortalRole) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PutWidgetConfigRequest) => putWidgets(role, input),
    onSuccess: (data) => {
      queryClient.setQueryData(widgetsQueryKey(role), data);
    },
  });
}

export async function reorderWidgets(
  role: SharedPortalRole,
  input: ReorderRequest,
): Promise<WidgetConfigResponse> {
  try {
    const payload = reorderRequestSchema.parse(input);
    const response = await api.patch<unknown>(
      `/admin/access-control/widgets/${role}/reorder`,
      payload,
    );
    const parsed = widgetConfigEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Widgets response did not match the expected shape: ${parsed.error.message}`);
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useReorderWidgetsMutation(role: SharedPortalRole) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ReorderRequest) => reorderWidgets(role, input),
    onSuccess: (data) => {
      queryClient.setQueryData(widgetsQueryKey(role), data);
    },
  });
}

// --- permissions ---------------------------------------------------------------------------

function permissionsQueryKey(role: SharedPortalRole) {
  return [...ROOT_KEY, 'permissions', role] as const;
}

export async function fetchPermissions(role: SharedPortalRole): Promise<PermissionsResponse> {
  try {
    const response = await api.get<unknown>(`/admin/access-control/permissions/${role}`);
    const parsed = permissionsEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Permissions response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function usePermissionsQuery(role: SharedPortalRole) {
  return useQuery({ queryKey: permissionsQueryKey(role), queryFn: () => fetchPermissions(role) });
}

export async function putPermissions(
  role: SharedPortalRole,
  input: PutPermissionsRequest,
): Promise<PermissionsResponse> {
  try {
    const payload = putPermissionsRequestSchema.parse(input);
    const response = await api.put<unknown>(`/admin/access-control/permissions/${role}`, payload);
    const parsed = permissionsEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Permissions response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function usePutPermissionsMutation(role: SharedPortalRole) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PutPermissionsRequest) => putPermissions(role, input),
    onSuccess: (data) => {
      queryClient.setQueryData(permissionsQueryKey(role), data);
    },
  });
}

// --- preview ---------------------------------------------------------------------------------

export async function preview(input: PreviewRequest): Promise<PreviewResponse> {
  try {
    const payload = previewRequestSchema.parse(input);
    const response = await api.post<unknown>('/admin/access-control/preview', payload);
    const parsed = previewEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Preview response did not match the expected shape: ${parsed.error.message}`);
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function usePreviewMutation() {
  return useMutation({ mutationFn: preview });
}
