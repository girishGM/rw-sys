/**
 * T-006 — typed REST wrapper around `tracking-service`'s API (ARCHITECTURE.md §3/§6). Every call
 * goes through {@link apiFetch}, which unwraps the `{ data: ... }` envelope every
 * `tracking-service` route uses (`routes/*.ts`) and turns a non-2xx response into a thrown
 * {@link ApiError} carrying the real HTTP status + the server's own message, not a generic
 * "fetch failed" — `lib/queries.ts`'s React Query hooks surface that as their `error` state.
 *
 * Base URL: `VITE_TRACKING_SERVICE_URL`, empty string by default so requests stay same-origin and
 * go through Vite's dev proxy (`vite.config.ts`'s `server.proxy['/api']` — see that file's own
 * comment). Read directly off `import.meta.env` rather than through a hand-written
 * `ImportMetaEnv` augmentation: `vite/client.d.ts` already types every env key via a permissive
 * index signature, and this workspace's `.eslintrc.cjs` `no-explicit-any` rule only flags an
 * *explicit* `any` annotation, not this implicit one, so no augmentation is needed to stay clean.
 */
import type {
  ActivityHistoryEntry,
  ActivityRequest,
  ActivityResult,
  CampaignDetail,
  CampaignSummary,
  Customer,
  DashboardSummary,
  RewardLedgerEntry,
} from '../types';

/** Resolves the configured tracking-service origin, or `''` (same-origin, dev-proxied) when
 * `VITE_TRACKING_SERVICE_URL` is unset — the "different dev/build contexts may run it on a
 * different port" case this task's implementation notes call out. */
export function apiBaseUrl(): string {
  const raw: unknown = import.meta.env.VITE_TRACKING_SERVICE_URL;
  return typeof raw === 'string' ? raw : '';
}

/** Thrown by every `apiClient` function on a non-2xx response. Carries the real status so a
 * caller (or a future error-boundary) can distinguish "unknown customer" (404) from "tracking-
 * service is down" (network failure / 502) instead of a single opaque error type. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface DataEnvelope<T> {
  readonly data: T;
}

interface ErrorEnvelope {
  readonly error: string;
}

function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
  return (
    typeof body === 'object' && body !== null && typeof (body as ErrorEnvelope).error === 'string'
  );
}

function isDataEnvelope<T>(body: unknown): body is DataEnvelope<T> {
  return typeof body === 'object' && body !== null && 'data' in body;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch (err) {
    // A network-level failure (tracking-service unreachable) never reaches `res.ok` below —
    // normalised to the same `ApiError` shape so every caller has one error type to handle.
    const message = err instanceof Error ? err.message : 'network request failed';
    throw new ApiError(message, 0);
  }

  const body: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const message = isErrorEnvelope(body) ? body.error : `request failed with status ${res.status}`;
    throw new ApiError(message, res.status);
  }
  if (!isDataEnvelope<T>(body)) {
    throw new ApiError('malformed response: missing "data"', res.status);
  }
  return body.data;
}

/** Appends `?customerId=` (or `&customerId=` if the path already has a query string) — every
 * route that takes one accepts it this way (`routes/validation.ts`'s `requireCustomerId`). */
function withCustomerId(path: string, customerId?: string | null): string {
  if (!customerId) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}customerId=${encodeURIComponent(customerId)}`;
}

export function getCustomers(): Promise<readonly Customer[]> {
  return apiFetch<readonly Customer[]>('/api/customers');
}

export function getDashboard(customerId: string): Promise<DashboardSummary> {
  return apiFetch<DashboardSummary>(withCustomerId('/api/dashboard', customerId));
}

/** `customerId` is optional here too, matching `routes/campaigns.ts` — a campaign list is
 * meaningful with or without a specific customer's progress layered on top. */
export function getCampaigns(customerId?: string | null): Promise<readonly CampaignSummary[]> {
  return apiFetch<readonly CampaignSummary[]>(withCustomerId('/api/campaigns', customerId));
}

export function getCampaign(code: string, customerId?: string | null): Promise<CampaignDetail> {
  return apiFetch<CampaignDetail>(
    withCustomerId(`/api/campaigns/${encodeURIComponent(code)}`, customerId),
  );
}

export function getRewards(customerId: string): Promise<readonly RewardLedgerEntry[]> {
  return apiFetch<readonly RewardLedgerEntry[]>(withCustomerId('/api/rewards', customerId));
}

export function postActivity(body: ActivityRequest): Promise<ActivityResult> {
  return apiFetch<ActivityResult>('/api/activities', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** T-010/T-013 — `GET /api/activities?customerId=`: this customer's real activity history,
 * most-recent-first — the Activity Simulator feed's data source. */
export function getActivities(customerId: string): Promise<readonly ActivityHistoryEntry[]> {
  return apiFetch<readonly ActivityHistoryEntry[]>(withCustomerId('/api/activities', customerId));
}
