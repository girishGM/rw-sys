/**
 * T-041 — the `/rules/:id/versions` and `/rewards/:id/versions` calls, following the shape
 * `features/rules/api.ts` (T-031) establishes: `lib/apiClient.ts`'s shared `api` instance,
 * every response parsed through the matching `packages/shared/src/version.schema.ts` schema.
 *
 * One generic module for both entity types, parameterised by `entityType` — the backend itself
 * is two parallel controllers (`RuleVersionsController`/`RewardVersionsController`) mounted at
 * different paths but with an identical route shape; this file is the front-end's equivalent
 * choice, made once instead of duplicated twice, since every call site here already has to
 * branch on `entityType` to pick the right Zod schema regardless.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  createVersionRequestSchema,
  rewardVersionEnvelopeSchema,
  rewardVersionListEnvelopeSchema,
  ruleVersionEnvelopeSchema,
  ruleVersionListEnvelopeSchema,
  updateRewardVersionRequestSchema,
  updateRuleVersionRequestSchema,
  versionCountryAssignmentListEnvelopeSchema,
  versionDiffEnvelopeSchema,
  type CreateVersionRequest,
  type RewardVersion,
  type RuleVersion,
  type UpdateRewardVersionRequest,
  type UpdateRuleVersionRequest,
  type VersionCountryAssignment,
  type VersionDiff,
} from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { toApiError } from '../../lib/apiError';

export type VersionEntityType = 'rule' | 'reward';
/** The one shape `VersionsPanel` needs regardless of entity type — `RuleVersion | RewardVersion`
 * both satisfy it structurally. */
export type AnyVersion = RuleVersion | RewardVersion;

function basePath(entityType: VersionEntityType, entityId: number): string {
  return entityType === 'rule'
    ? `/rules/${String(entityId)}/versions`
    : `/rewards/${String(entityId)}/versions`;
}

export function versionsQueryKey(
  entityType: VersionEntityType,
  entityId: number,
): readonly [string, VersionEntityType, number, string] {
  return ['versions', entityType, entityId, 'list'] as const;
}

export async function fetchVersions(
  entityType: VersionEntityType,
  entityId: number,
): Promise<readonly AnyVersion[]> {
  try {
    const response = await api.get<unknown>(basePath(entityType, entityId));
    const schema =
      entityType === 'rule' ? ruleVersionListEnvelopeSchema : rewardVersionListEnvelopeSchema;
    const parsed = schema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Versions list response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useVersionsQuery(entityType: VersionEntityType, entityId: number) {
  return useQuery({
    queryKey: versionsQueryKey(entityType, entityId),
    queryFn: () => fetchVersions(entityType, entityId),
  });
}

export async function createDraft(
  entityType: VersionEntityType,
  entityId: number,
  input: CreateVersionRequest,
): Promise<AnyVersion> {
  try {
    const payload = createVersionRequestSchema.parse(input);
    const response = await api.post<unknown>(basePath(entityType, entityId), payload);
    const schema = entityType === 'rule' ? ruleVersionEnvelopeSchema : rewardVersionEnvelopeSchema;
    const parsed = schema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-draft response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCreateDraftMutation(entityType: VersionEntityType, entityId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateVersionRequest) => createDraft(entityType, entityId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: versionsQueryKey(entityType, entityId) });
    },
  });
}

export async function updateDraft(
  entityType: VersionEntityType,
  entityId: number,
  versionId: number,
  input: UpdateRuleVersionRequest | UpdateRewardVersionRequest,
): Promise<AnyVersion> {
  try {
    const payload =
      entityType === 'rule'
        ? updateRuleVersionRequestSchema.parse(input)
        : updateRewardVersionRequestSchema.parse(input);
    const response = await api.patch<unknown>(
      `${basePath(entityType, entityId)}/${String(versionId)}`,
      payload,
    );
    const schema = entityType === 'rule' ? ruleVersionEnvelopeSchema : rewardVersionEnvelopeSchema;
    const parsed = schema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Update-draft response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useUpdateDraftMutation(
  entityType: VersionEntityType,
  entityId: number,
  versionId: number,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateRuleVersionRequest | UpdateRewardVersionRequest) =>
      updateDraft(entityType, entityId, versionId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: versionsQueryKey(entityType, entityId) });
    },
  });
}

export async function transition(
  entityType: VersionEntityType,
  entityId: number,
  versionId: number,
  action: 'publish' | 'deprecate' | 'retire',
): Promise<AnyVersion> {
  try {
    const response = await api.post<unknown>(
      `${basePath(entityType, entityId)}/${String(versionId)}/${action}`,
    );
    const schema = entityType === 'rule' ? ruleVersionEnvelopeSchema : rewardVersionEnvelopeSchema;
    const parsed = schema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `${action} response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useVersionTransitionMutation(
  entityType: VersionEntityType,
  entityId: number,
  action: 'publish' | 'deprecate' | 'retire',
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (versionId: number) => transition(entityType, entityId, versionId, action),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: versionsQueryKey(entityType, entityId) });
    },
  });
}

export function versionDiffQueryKey(
  entityType: VersionEntityType,
  entityId: number,
  versionId: number,
  otherVersionId: number,
): readonly [string, VersionEntityType, number, string, number, number] {
  return ['versions', entityType, entityId, 'diff', versionId, otherVersionId] as const;
}

export async function fetchVersionDiff(
  entityType: VersionEntityType,
  entityId: number,
  versionId: number,
  otherVersionId: number,
): Promise<VersionDiff> {
  try {
    const response = await api.get<unknown>(
      `${basePath(entityType, entityId)}/${String(versionId)}/diff/${String(otherVersionId)}`,
    );
    const parsed = versionDiffEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Diff response did not match the expected shape: ${parsed.error.message}`);
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useVersionDiffQuery(
  entityType: VersionEntityType,
  entityId: number,
  versionId: number | null,
  otherVersionId: number | null,
) {
  return useQuery({
    queryKey: versionDiffQueryKey(entityType, entityId, versionId ?? 0, otherVersionId ?? 0),
    queryFn: () => fetchVersionDiff(entityType, entityId, versionId ?? 0, otherVersionId ?? 0),
    enabled: versionId !== null && otherVersionId !== null,
  });
}

export function versionCountriesQueryKey(
  entityType: VersionEntityType,
  entityId: number,
  versionId: number,
): readonly [string, VersionEntityType, number, string, number] {
  return ['versions', entityType, entityId, 'countries', versionId] as const;
}

export async function fetchVersionCountries(
  entityType: VersionEntityType,
  entityId: number,
  versionId: number,
): Promise<readonly VersionCountryAssignment[]> {
  try {
    const response = await api.get<unknown>(
      `${basePath(entityType, entityId)}/${String(versionId)}/countries`,
    );
    const parsed = versionCountryAssignmentListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Version-countries response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useVersionCountriesQuery(
  entityType: VersionEntityType,
  entityId: number,
  versionId: number,
) {
  return useQuery({
    queryKey: versionCountriesQueryKey(entityType, entityId, versionId),
    queryFn: () => fetchVersionCountries(entityType, entityId, versionId),
  });
}

export async function withdrawVersionFromCountry(
  entityType: VersionEntityType,
  entityId: number,
  versionId: number,
  countryId: number,
): Promise<void> {
  try {
    await api.delete(
      `${basePath(entityType, entityId)}/${String(versionId)}/countries/${String(countryId)}`,
    );
  } catch (error) {
    throw toApiError(error);
  }
}

export function useWithdrawVersionMutation(
  entityType: VersionEntityType,
  entityId: number,
  versionId: number,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (countryId: number) =>
      withdrawVersionFromCountry(entityType, entityId, versionId, countryId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: versionCountriesQueryKey(entityType, entityId, versionId),
      });
    },
  });
}

// Re-exported so callers of this module don't also need a direct `@reward-portal/shared` import
// just for the return type of `useVersionsQuery`/`useVersionDiffQuery`.
export type {
  RuleVersion,
  RewardVersion,
  VersionDiff,
  VersionCountryAssignment,
} from '@reward-portal/shared';
export type UseVersionsResult = UseQueryResult<
  readonly AnyVersion[],
  ReturnType<typeof toApiError>
>;
