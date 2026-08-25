/**
 * T-034 — `/tenants/:id`: one tenant's detail, its lifecycle actions, and its budget ceilings.
 *
 * Lifecycle (implementation note 3): `pending_provisioning` → `active` via the dedicated
 * `POST /:id/activate` action; `active` → `suspended`/`inactive` via `PATCH /:id`. Suspending
 * revokes every session belonging to that tenant's users (implementation note 8, TC-18) — this
 * screen surfaces that consequence explicitly in the confirmation dialog rather than letting a
 * click silently log out every one of the tenant's users.
 */
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Ban, ShieldOff, UserPlus } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { Skeleton } from '../../components/Skeleton';
import { useBootstrap } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';
import { AddTenantAdminModal } from './AddTenantAdminModal';
import { BudgetCeilingsPanel } from './BudgetCeilingsPanel';
import { useActivateTenantMutation, useTenantQuery, useUpdateTenantMutation } from './api';

const STATUS_TONE: Record<string, 'success' | 'slate' | 'warning' | 'danger'> = {
  pending_provisioning: 'warning',
  active: 'success',
  inactive: 'slate',
  suspended: 'danger',
};

export function TenantDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { hasPermission } = useBootstrap();
  const canUpdate = hasPermission('tenant', 'update');

  const [addAdminOpen, setAddAdminOpen] = useState(false);
  const [confirmSuspendOpen, setConfirmSuspendOpen] = useState(false);

  const tenantQuery = useTenantQuery(id);
  const activateMutation = useActivateTenantMutation(id);
  const updateMutation = useUpdateTenantMutation(id);

  if (!Number.isFinite(id)) {
    return (
      <div className="p-6">
        <EmptyState message="Invalid tenant id" />
      </div>
    );
  }

  if (tenantQuery.isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (tenantQuery.isError || tenantQuery.data === undefined) {
    const message =
      tenantQuery.error instanceof ApiError
        ? tenantQuery.error.message
        : 'Could not load this tenant.';
    return (
      <div className="p-6">
        <EmptyState icon={Ban} message="Could not load this tenant" description={message} />
      </div>
    );
  }

  const tenant = tenantQuery.data;

  function suspend(): void {
    updateMutation.mutate(
      { status: 'suspended' },
      { onSuccess: () => setConfirmSuspendOpen(false) },
    );
  }

  function activate(): void {
    activateMutation.mutate();
  }

  return (
    <div className="p-6">
      <PageHeader
        title={tenant.name}
        description={tenant.code}
        actions={
          canUpdate && (
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={() => setAddAdminOpen(true)}>
                <UserPlus className="size-4" aria-hidden="true" />
                Add Tenant Admin
              </Button>
              {tenant.status === 'pending_provisioning' && (
                <Button type="button" onClick={activate} isLoading={activateMutation.isPending}>
                  Activate
                </Button>
              )}
              {tenant.status === 'active' && (
                <Button
                  type="button"
                  variant="danger"
                  onClick={() => setConfirmSuspendOpen(true)}
                  isLoading={updateMutation.isPending}
                >
                  <ShieldOff className="size-4" aria-hidden="true" />
                  Suspend
                </Button>
              )}
            </div>
          )
        }
      />

      <div className="flex flex-wrap items-center gap-2 pb-4">
        <Badge tone={STATUS_TONE[tenant.status] ?? 'slate'}>{tenant.status}</Badge>
      </div>

      <Card className="mb-4">
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-900">Details</h2>
        </CardHeader>
        <CardBody>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Schema prefix</dt>
              <dd className="mt-0.5 text-slate-900">{tenant.schemaPrefix ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Contact email</dt>
              <dd className="mt-0.5 text-slate-900">{tenant.contactEmail ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Contact phone</dt>
              <dd className="mt-0.5 text-slate-900">{tenant.contactPhone ?? '—'}</dd>
            </div>
          </dl>
        </CardBody>
      </Card>

      <div className="mb-4">
        <BudgetCeilingsPanel tenantId={id} />
      </div>

      <AddTenantAdminModal
        open={addAdminOpen}
        onClose={() => setAddAdminOpen(false)}
        tenantId={id}
      />

      <ConfirmDialog
        open={confirmSuspendOpen}
        onCancel={() => setConfirmSuspendOpen(false)}
        onConfirm={suspend}
        title="Suspend this tenant?"
        description="Every user in this tenant will be logged out immediately and unable to sign back in until the tenant is reactivated. This does not affect existing campaigns."
        confirmLabel="Suspend anyway"
        variant="destructive"
        isConfirming={updateMutation.isPending}
      />
    </div>
  );
}
