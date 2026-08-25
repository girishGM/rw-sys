/**
 * T-023 — resolves the top bar's context chip labels (04-FRONTEND.md §1: *"which world am I
 * in" must never require a click"*).
 *
 * ### The gap this papers over, honestly
 *
 * `/me/bootstrap`'s `scope` (`bootstrap.schema.ts`) is deliberately IDs only — `countryId`,
 * `tenantId`, `merchantId` — never names, and never should be more than that: it exists so the
 * server-verified JWT scope can be *reported*, not so the client can invent display copy from
 * it (AGENT-PROTOCOL R3). 04-FRONTEND.md §1's mock shows names ("Malaysia · Acme Retail"), which
 * means resolving id → name is this task's job, not something bootstrap hands over pre-resolved.
 *
 * 03-API-CONTRACT.md §5/§6 name the routes this resolves through — `GET /countries/:id` and
 * `GET /tenants/:id` — but neither that file nor `01-DATABASE.md` (which does confirm both
 * tables carry a `name` column) specifies a response *shape* for either, because neither route
 * exists yet: `back-end/src/modules` has no `countries`/`tenants` module (T-030/T-034, both still
 * `pending`). This hook is therefore built exactly like every widget in `features/dashboard`
 * (see that module's `api.ts`) — a real client for a documented-but-unbuilt route, degrading to a
 * numbered fallback (`"Country #3"`) rather than blocking or erroring the whole top bar while
 * that route doesn't exist. **Flagged for the architect in the completion report**, same as the
 * dashboard widgets: once T-030/T-034 ship a real `{ data: { name } }` shape, this hook either
 * already matches it or needs a one-line adjustment — nothing else in the shell depends on the
 * guess being exactly right today.
 */
import { useQuery } from '@tanstack/react-query';
import type { BootstrapScope } from '@reward-portal/shared';
import { api } from '../lib/apiClient';

export interface ScopeLabels {
  readonly countryLabel: string | null;
  readonly tenantLabel: string | null;
}

interface NamedResource {
  readonly name?: unknown;
}

function scopeLabelQueryKey(path: string): readonly [string, string] {
  return ['scope-label', path] as const;
}

async function fetchName(path: string): Promise<string | null> {
  const response = await api.get<{ data: NamedResource }>(path);
  const { name } = response.data.data;
  return typeof name === 'string' && name.trim() !== '' ? name : null;
}

function useResolvedName(path: string | null): string | undefined {
  const query = useQuery({
    queryKey: scopeLabelQueryKey(path ?? ''),
    queryFn: () => fetchName(path as string),
    enabled: path !== null,
    staleTime: 5 * 60 * 1000,
  });
  return query.data ?? undefined;
}

/** `null` when the scope carries no id for that level (e.g. no `tenantId` for a country_admin). */
export function useScopeLabels(scope: BootstrapScope | undefined): ScopeLabels {
  const countryPath = scope?.countryId != null ? `/countries/${scope.countryId}` : null;
  const tenantPath = scope?.tenantId != null ? `/tenants/${scope.tenantId}` : null;

  const countryName = useResolvedName(countryPath);
  const tenantName = useResolvedName(tenantPath);

  return {
    countryLabel: countryPath === null ? null : (countryName ?? `Country #${scope!.countryId}`),
    tenantLabel: tenantPath === null ? null : (tenantName ?? `Tenant #${scope!.tenantId}`),
  };
}
