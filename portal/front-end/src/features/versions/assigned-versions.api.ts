/**
 * T-041 — `GET /countries/:id/assigned-versions` (06-VERSIONING.md §10, "Country → Assigned
 * versions"). Split from `./api.ts` — that file is about a rule/reward's own versions;
 * this endpoint is about a country's holdings across both, a different axis entirely.
 */
import { useQuery } from '@tanstack/react-query';
import { assignedVersionListEnvelopeSchema, type AssignedVersion } from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { toApiError } from '../../lib/apiError';

export function assignedVersionsQueryKey(countryId: number): readonly [string, number, string] {
  return ['countries', countryId, 'assigned-versions'] as const;
}

export async function fetchAssignedVersions(
  countryId: number,
): Promise<readonly AssignedVersion[]> {
  try {
    const response = await api.get<unknown>(`/countries/${String(countryId)}/assigned-versions`);
    const parsed = assignedVersionListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Assigned-versions response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useAssignedVersionsQuery(countryId: number) {
  return useQuery({
    queryKey: assignedVersionsQueryKey(countryId),
    queryFn: () => fetchAssignedVersions(countryId),
  });
}
