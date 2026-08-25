/**
 * T-034 — `/tenants`: the Tenants list (03-API-CONTRACT.md §6, 04-FRONTEND.md's
 * "Tenants list / detail | country_admin | Onboard tenant → then 'Create Tenant Admin'").
 *
 * Reached through `router.tsx`'s `RequirePermission entity="tenant" action="view"` guard —
 * everyone who can navigate here can already see every row scope allows (`country_admin` sees
 * only its own country's tenants, `tenant_admin` sees only its own — `TenantsService.list`'s own
 * header explains why no client-side branch is needed for that). "Add tenant" is gated a second,
 * independent time here, on `tenant:create`, the same two-independent-controls shape
 * `CountriesListPage.tsx` documents (00-ARCHITECTURE.md §7): a hidden button never stands alone
 * as the control, and the server would 403 a `tenant_admin` who forged the request anyway
 * (TC-6).
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import type { Tenant } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { Table, type TableColumn } from '../../components/Table';
import { useBootstrap } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';
import { AddTenantModal } from './AddTenantModal';
import { useTenantsQuery, type TenantListParams } from './api';

const STATUS_TONE: Record<Tenant['status'], 'success' | 'slate' | 'warning' | 'danger'> = {
  pending_provisioning: 'warning',
  active: 'success',
  inactive: 'slate',
  suspended: 'danger',
};

const COLUMNS: TableColumn<Tenant>[] = [
  { key: 'code', header: 'Code', render: (row) => row.code, sortable: true },
  { key: 'name', header: 'Name', render: (row) => row.name, sortable: true },
  {
    key: 'status',
    header: 'Status',
    render: (row) => <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>,
    sortable: true,
  },
];

export function TenantsListPage() {
  const { hasPermission } = useBootstrap();
  const [params, setParams] = useState<TenantListParams>({ page: 1, sort: 'name:asc' });
  const [addOpen, setAddOpen] = useState(false);
  const navigate = useNavigate();

  const { data, isLoading, error } = useTenantsQuery(params);
  const canCreate = hasPermission('tenant', 'create');

  function handleSortChange(key: string): void {
    setParams((current) => {
      const [currentField, currentDirection] = (current.sort ?? 'name:asc').split(':');
      const direction = currentField === key && currentDirection === 'asc' ? 'desc' : 'asc';
      return { ...current, page: 1, sort: `${key}:${direction}` };
    });
  }

  const [sortField, sortDirection] = (params.sort ?? 'name:asc').split(':') as [
    string,
    'asc' | 'desc',
  ];

  return (
    <div className="p-6">
      <PageHeader
        title="Tenants"
        description="Onboard a tenant within your country, then its Tenant Admin."
        actions={
          canCreate && (
            <Button type="button" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Add tenant
            </Button>
          )
        }
      />

      <Table
        caption="Tenants"
        columns={COLUMNS}
        data={data ? [...data.data] : []}
        getRowId={(row) => row.id}
        isLoading={isLoading}
        error={error instanceof ApiError ? error.message : null}
        emptyMessage="No tenants yet"
        emptyDescription={canCreate ? 'Add the first tenant to get started.' : undefined}
        sort={{ key: sortField, direction: sortDirection }}
        onSortChange={handleSortChange}
        onRowClick={(row) => navigate(`/tenants/${String(row.id)}`)}
      />

      {data && data.meta.total > data.meta.pageSize && (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
          <span>
            Page {data.meta.page} of {Math.ceil(data.meta.total / data.meta.pageSize)}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={data.meta.page <= 1}
              onClick={() => setParams((current) => ({ ...current, page: data.meta.page - 1 }))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={data.meta.page * data.meta.pageSize >= data.meta.total}
              onClick={() => setParams((current) => ({ ...current, page: data.meta.page + 1 }))}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <AddTenantModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
