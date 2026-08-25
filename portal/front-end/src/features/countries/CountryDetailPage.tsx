/**
 * T-030 — `/countries/:id`: one country's detail, its tenant/campaign summary, and the two
 * actions Super Admin has here — onboard its admin, and (de)activate it.
 *
 * Deactivation never cascades (implementation note 7, `CountriesService.update`'s own header):
 * this screen surfaces the warning — the summary's own tenant list — and requires an explicit
 * confirmation before sending `confirm: true`, rather than letting a click silently flip the
 * flag while tenants are still active.
 */
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Ban, UserPlus } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { Skeleton } from '../../components/Skeleton';
import { useBootstrap } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';
import { useAssignedVersionsQuery } from '../versions';
import { AddCountryAdminModal } from './AddCountryAdminModal';
import { useCountryQuery, useCountrySummaryQuery, useUpdateCountryMutation } from './api';

export function CountryDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { hasPermission } = useBootstrap();
  const canUpdate = hasPermission('country', 'update');

  const [addAdminOpen, setAddAdminOpen] = useState(false);
  const [confirmDeactivateOpen, setConfirmDeactivateOpen] = useState(false);

  const countryQuery = useCountryQuery(id);
  const summaryQuery = useCountrySummaryQuery(id);
  const updateMutation = useUpdateCountryMutation(id);
  const assignedVersionsQuery = useAssignedVersionsQuery(id);

  if (!Number.isFinite(id)) {
    return (
      <div className="p-6">
        <EmptyState message="Invalid country id" />
      </div>
    );
  }

  if (countryQuery.isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (countryQuery.isError || countryQuery.data === undefined) {
    const message =
      countryQuery.error instanceof ApiError
        ? countryQuery.error.message
        : 'Could not load this country.';
    return (
      <div className="p-6">
        <EmptyState icon={Ban} message="Could not load this country" description={message} />
      </div>
    );
  }

  const country = countryQuery.data;
  const summary = summaryQuery.data;
  const activeTenantCount = summary?.activeTenantCount ?? 0;

  function requestDeactivate(): void {
    if (activeTenantCount > 0) {
      setConfirmDeactivateOpen(true);
      return;
    }
    updateMutation.mutate({ status: 'inactive' });
  }

  function confirmDeactivate(): void {
    updateMutation.mutate(
      { status: 'inactive', confirm: true },
      { onSuccess: () => setConfirmDeactivateOpen(false) },
    );
  }

  function activate(): void {
    updateMutation.mutate({ status: 'active' });
  }

  return (
    <div className="p-6">
      <PageHeader
        title={country.name}
        description={`${country.code} · ${country.timezone} · ${country.currencyCode}`}
        actions={
          canUpdate && (
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={() => setAddAdminOpen(true)}>
                <UserPlus className="size-4" aria-hidden="true" />
                Add Country Admin
              </Button>
              {country.status === 'active' ? (
                <Button
                  type="button"
                  variant="danger"
                  onClick={requestDeactivate}
                  isLoading={updateMutation.isPending}
                >
                  Deactivate
                </Button>
              ) : (
                <Button type="button" onClick={activate} isLoading={updateMutation.isPending}>
                  Activate
                </Button>
              )}
            </div>
          )
        }
      />

      <div className="flex flex-wrap items-center gap-2 pb-4">
        <Badge tone={country.status === 'active' ? 'success' : 'slate'}>{country.status}</Badge>
        {country.isHq && <Badge tone="primary">HQ</Badge>}
      </div>

      <Card className="mb-4">
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-900">Tenants and campaigns</h2>
        </CardHeader>
        <CardBody>
          {summaryQuery.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : summary === undefined ? (
            <p className="text-sm text-slate-500">Could not load the summary.</p>
          ) : (
            <>
              <dl className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-400">Tenants</dt>
                  <dd className="mt-0.5 text-lg font-semibold text-slate-900">
                    {summary.tenantCount}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-400">Active tenants</dt>
                  <dd className="mt-0.5 text-lg font-semibold text-slate-900">
                    {summary.activeTenantCount}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-400">Campaigns</dt>
                  <dd className="mt-0.5 text-lg font-semibold text-slate-900">
                    {summary.campaignCount}
                  </dd>
                </div>
              </dl>
              {summary.tenants.length > 0 && (
                <ul className="mt-4 divide-y divide-slate-100 text-sm">
                  {summary.tenants.map((tenant) => (
                    <li key={tenant.id} className="flex items-center justify-between py-2">
                      <span>
                        {tenant.name} <span className="text-slate-400">({tenant.code})</span>
                      </span>
                      <Badge tone={tenant.status === 'active' ? 'success' : 'slate'}>
                        {tenant.status}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </CardBody>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-900">Assigned rule/reward versions</h2>
        </CardHeader>
        <CardBody>
          {assignedVersionsQuery.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (assignedVersionsQuery.data ?? []).length === 0 ? (
            <p className="text-sm text-slate-500">No versions blasted to this country yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {(assignedVersionsQuery.data ?? []).map((row) => (
                <li
                  key={`${row.entityType}-${String(row.entityId)}-${String(row.versionId)}`}
                  className="flex items-center justify-between py-2"
                >
                  <span>
                    <span className="capitalize text-slate-400">{row.entityType}</span>{' '}
                    {row.entityName} <span className="text-slate-400">({row.entityCode})</span> · v
                    {row.versionNo}
                  </span>
                  <Badge tone={row.status === 'active' ? 'success' : 'slate'}>{row.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <AddCountryAdminModal
        open={addAdminOpen}
        onClose={() => setAddAdminOpen(false)}
        countryId={id}
      />

      <ConfirmDialog
        open={confirmDeactivateOpen}
        onCancel={() => setConfirmDeactivateOpen(false)}
        onConfirm={confirmDeactivate}
        title="Deactivate a country with active tenants?"
        description={`${String(
          activeTenantCount,
        )} tenant(s) are still active under this country. Deactivating the country does not affect them — they keep their current status. This action does not cascade.`}
        confirmLabel="Deactivate anyway"
        variant="destructive"
        isConfirming={updateMutation.isPending}
      />
    </div>
  );
}
