/**
 * T-035 — `/users`: the Users list (03-API-CONTRACT.md §7).
 *
 * Reached through `router.tsx`'s `RequirePermission entity="user" action="view"` guard —
 * everyone who can navigate here can already see every row scope allows (`UsersService.list`'s
 * own header: `country_admin` sees its country's users, `tenant_admin`/`maker`/`checker` its
 * tenant's, no branch here tells the roles apart). "Add user" is gated a second, independent
 * time here, on `user:create`, the same two-independent-controls shape `TenantsListPage.tsx`
 * documents.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import type { User } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { Table, type TableColumn } from '../../components/Table';
import { useBootstrap } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';
import { AddUserModal } from './AddUserModal';
import { useUsersQuery, type UserListParams } from './api';

const STATUS_TONE: Record<User['status'], 'success' | 'slate' | 'warning' | 'danger'> = {
  pending_activation: 'warning',
  active: 'success',
  inactive: 'slate',
  locked: 'danger',
  suspended: 'danger',
};

const ROLE_LABELS: Record<User['role'], string> = {
  super_admin: 'Super Admin',
  country_admin: 'Country Admin',
  tenant_admin: 'Tenant Admin',
  maker: 'Maker',
  checker: 'Checker',
  merchant: 'Merchant',
};

const COLUMNS: TableColumn<User>[] = [
  { key: 'displayName', header: 'Name', render: (row) => row.displayName, sortable: true },
  { key: 'email', header: 'Email', render: (row) => row.email, sortable: true },
  { key: 'role', header: 'Role', render: (row) => ROLE_LABELS[row.role], sortable: true },
  {
    key: 'status',
    header: 'Status',
    render: (row) => <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>,
    sortable: true,
  },
];

export function UsersListPage() {
  const { hasPermission } = useBootstrap();
  const [params, setParams] = useState<UserListParams>({ page: 1, sort: 'displayName:asc' });
  const [addOpen, setAddOpen] = useState(false);
  const navigate = useNavigate();

  const { data, isLoading, error } = useUsersQuery(params);
  const canCreate = hasPermission('user', 'create');

  function handleSortChange(key: string): void {
    setParams((current) => {
      const [currentField, currentDirection] = (current.sort ?? 'displayName:asc').split(':');
      const direction = currentField === key && currentDirection === 'asc' ? 'desc' : 'asc';
      return { ...current, page: 1, sort: `${key}:${direction}` };
    });
  }

  const [sortField, sortDirection] = (params.sort ?? 'displayName:asc').split(':') as [
    string,
    'asc' | 'desc',
  ];

  return (
    <div className="p-6">
      <PageHeader
        title="Users"
        description="Everyone with portal access within your scope."
        actions={
          canCreate && (
            <Button type="button" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Add user
            </Button>
          )
        }
      />

      <Table
        caption="Users"
        columns={COLUMNS}
        data={data ? [...data.data] : []}
        getRowId={(row) => row.id}
        isLoading={isLoading}
        error={error instanceof ApiError ? error.message : null}
        emptyMessage="No users yet"
        emptyDescription={canCreate ? 'Add the first user to get started.' : undefined}
        sort={{ key: sortField, direction: sortDirection }}
        onSortChange={handleSortChange}
        onRowClick={(row) => navigate(`/users/${String(row.id)}`)}
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

      <AddUserModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
