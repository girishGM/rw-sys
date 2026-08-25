/**
 * T-040 — the calls `/audit` makes: `GET /audit/campaigns`, `GET /audit/portal`
 * (03-API-CONTRACT.md §14), and the two CSV export URLs.
 *
 * Uses `lib/apiClient.ts`'s shared `api` instance (T-022), the same choice `features/trace/api.ts`
 * makes and for the same reason: an ordinary authenticated `GET` wants the single-flight 401
 * refresh and transport-payload decryption `api` already provides.
 *
 * No zod schema here (unlike `features/trace/api.ts`'s `traceResponseSchema`): `trace.schema.ts`
 * lives in this task's sibling `packages/shared/src/trace.schema.ts`, but no `audit.schema.ts` is
 * among T-040's *Files owned* (`packages/shared/src/merchant-portal.schema.ts` and
 * `trace.schema.ts` only) — adding one would be a new shared-schema file this task was not
 * granted. The response shape is trusted at the TypeScript level only, the same choice
 * `layouts/notificationsApi.ts` (T-023) already makes for `/notifications`.
 */
import { api } from '../../lib/apiClient';
import { toApiError } from '../../lib/apiError';

export interface CampaignAuditRow {
  readonly id: number;
  readonly tenantId: number;
  readonly campaignId: number;
  readonly entityType: string;
  readonly entityId: number | null;
  readonly action: string;
  readonly fieldChanges: Record<string, unknown>;
  readonly performedBy: number;
  readonly performedAt: string;
  readonly approvedBy: number | null;
  readonly approvedAt: string | null;
  readonly comment: string | null;
}

export interface PortalAuditRow {
  readonly id: string;
  readonly eventType: string;
  readonly actorId: number | null;
  readonly actorRole: string | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly countryId: number | null;
  readonly tenantId: number | null;
  readonly ipAddress: string | null;
  readonly detail: Record<string, unknown> | null;
  readonly occurredAt: string;
}

export interface ListMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface AuditFilters {
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly actorId?: number;
  readonly action?: string;
  readonly entityType?: string;
  readonly eventType?: string;
  readonly targetType?: string;
  readonly campaignId?: number;
  readonly page?: number;
  readonly pageSize?: number;
}

/** Only the whitelisted keys `list-audit-query.dto.ts` (back end) declares — `undefined`/`''`
 * values are dropped rather than sent, so an empty filter never becomes `?actorId=`. */
function toQueryParams(filters: AuditFilters): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === '') continue;
    params[key] = value as string | number;
  }
  return params;
}

export const AUDIT_CAMPAIGNS_QUERY_KEY = ['audit', 'campaigns'] as const;
export const AUDIT_PORTAL_QUERY_KEY = ['audit', 'portal'] as const;

export async function fetchCampaignAudit(
  filters: AuditFilters,
): Promise<{ data: readonly CampaignAuditRow[]; meta: ListMeta }> {
  try {
    const response = await api.get<{ data: CampaignAuditRow[]; meta: ListMeta }>(
      '/audit/campaigns',
      { params: toQueryParams(filters) },
    );
    return response.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export async function fetchPortalAudit(
  filters: AuditFilters,
): Promise<{ data: readonly PortalAuditRow[]; meta: ListMeta }> {
  try {
    const response = await api.get<{ data: PortalAuditRow[]; meta: ListMeta }>('/audit/portal', {
      params: toQueryParams(filters),
    });
    return response.data;
  } catch (error) {
    throw toApiError(error);
  }
}

/**
 * The CSV export URL, for a plain browser navigation (`<a href>`) rather than an `api` call.
 *
 * `GET` carries no `X-CSRF-Token` requirement (03-API-CONTRACT.md §1: only mutating requests
 * do), and the session cookie travels with an ordinary same-origin navigation exactly as it does
 * with `axios`'s `withCredentials: true` — so a direct link, letting the browser handle the
 * `Content-Disposition: attachment` response itself, is both simpler and more correct here than
 * fetching the blob through `api` and re-triggering a download manually.
 */
export function auditExportUrl(scope: 'campaigns' | 'portal', filters: AuditFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(toQueryParams(filters))) {
    params.set(key, String(value));
  }
  const query = params.toString();
  return `/api/v1/audit/${scope}/export${query.length > 0 ? `?${query}` : ''}`;
}
