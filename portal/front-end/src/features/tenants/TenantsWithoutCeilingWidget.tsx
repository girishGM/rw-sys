/**
 * T-034 implementation note 7 / TC-28 — "Add a 'Tenants without a budget ceiling' widget to the
 * Country Admin dashboard, since an unconfigured ceiling means unlimited and should be visible
 * to the person who can close it."
 *
 * ### Why this is a self-contained component here, not a line in `widgetRegistry.ts`
 *
 * `front-end/src/features/dashboard/**` (the `DashboardPage`/`WIDGET_REGISTRY`/`ListWidget`
 * machinery, and the `GET /dashboard/widgets/:widgetKey` route the generic `list_*` widgets all
 * call) is T-023's file scope, not this task's — `front-end/src/features/tenants/**` only. The
 * seed data already carries the wiring on the *config* side: `T004_003_seed_role_dashboard_
 * widgets.ts` seeds `list_tenants_without_ceiling` for `country_admin`, and `widgetRegistry.ts`
 * (T-023) already maps that key to a generic `ListWidget` pointed at
 * `GET /dashboard/widgets/list_tenants_without_ceiling`. What is missing is the **backend route**
 * that serves any `widget_key` at all — `features/dashboard/widgets/api.ts`'s own header already
 * discloses this as a gap no task's declared file scope currently owns (T-023's own flagged
 * finding, not new here).
 *
 * This component is this task's own, directly usable rendering of the same data
 * (`GET /tenants/without-budget-ceiling`, `TenantsService.listTenantsWithoutCeiling`) — a real,
 * working widget, just not yet reachable through the generic per-`widgetKey` dashboard route.
 * Once a `DashboardModule` (or equivalent) exists to serve that route, the two sensible paths are
 * either (a) have it call `TenantsService.listTenantsWithoutCeiling()` directly for the
 * `list_tenants_without_ceiling` key, keeping `ListWidget`'s generic rendering, or (b) swap this
 * component in the same way `DashboardPage.tsx` already special-cases a handful of richer widgets
 * over the generic factories. Either is a decision for whoever builds that module, flagged here
 * and in the completion report rather than guessed at by editing another task's files (R9).
 */
import { AlertTriangle } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Skeleton } from '../../components/Skeleton';
import { ApiError } from '../../lib/apiError';
import { useTenantsWithoutCeilingQuery } from './api';

export function TenantsWithoutCeilingWidget() {
  const { data, isLoading, isError, error } = useTenantsWithoutCeilingQuery();

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-medium text-slate-700">Tenants without a budget ceiling</h2>
      </CardHeader>
      <CardBody>
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : isError ? (
          <p role="alert" className="text-sm text-danger-700">
            {error instanceof ApiError ? error.message : "Couldn't load this list."}
          </p>
        ) : data === undefined || data.length === 0 ? (
          <EmptyState message="Every tenant has a budget ceiling" />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {data.map((tenant) => (
              <li key={tenant.id} className="flex items-center justify-between py-2">
                <span>
                  {tenant.name} <span className="text-slate-400">({tenant.code})</span>
                </span>
                <Badge tone="warning">
                  <AlertTriangle className="mr-1 inline size-3" aria-hidden="true" />
                  Unlimited
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
