/**
 * T-036 — `/merchants`: the Merchants list (TC-21/TC-22 — server-side search and pagination).
 *
 * Reached through `router.tsx`'s `RequirePermission entity="merchant" action="view"` guard —
 * everyone who can navigate here can already see every row scope allows (a `tenant_admin` sees
 * only its own tenant's merchants, a `merchant` user exactly one row — its own —
 * `MerchantsService.list`'s own header explains why no client-side branch is needed for that).
 * "Add merchant" is gated a second, independent time here, on `merchant:create`, the same
 * two-independent-controls shape `TenantsListPage.tsx` documents.
 */
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import type { Merchant } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { PageHeader } from '../../components/PageHeader';
import { Table, type TableColumn } from '../../components/Table';
import { useBootstrap } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';
import { AddMerchantModal } from './AddMerchantModal';
import { useMerchantsQuery, type MerchantListParams } from './api';

const STATUS_TONE: Record<Merchant['status'], 'success' | 'slate' | 'warning' | 'danger'> = {
  active: 'success',
  inactive: 'slate',
  suspended: 'danger',
};

const COLUMNS: TableColumn<Merchant>[] = [
  { key: 'merchantCode', header: 'Code', render: (row) => row.merchantCode, sortable: true },
  { key: 'name', header: 'Name', render: (row) => row.name, sortable: true },
  { key: 'countryCode', header: 'Country', render: (row) => row.countryCode },
  {
    key: 'status',
    header: 'Status',
    render: (row) => <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>,
    sortable: true,
  },
];

export function MerchantsListPage() {
  const { hasPermission } = useBootstrap();
  const [params, setParams] = useState<MerchantListParams>({ page: 1, sort: 'name:asc' });
  const [searchInput, setSearchInput] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const navigate = useNavigate();

  const { data, isLoading, error } = useMerchantsQuery(params);
  const canCreate = hasPermission('merchant', 'create');

  function handleSortChange(key: string): void {
    setParams((current) => {
      const [currentField, currentDirection] = (current.sort ?? 'name:asc').split(':');
      const direction = currentField === key && currentDirection === 'asc' ? 'desc' : 'asc';
      return { ...current, page: 1, sort: `${key}:${direction}` };
    });
  }

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setParams((current) => ({ ...current, page: 1, search: searchInput || undefined }));
  }

  const [sortField, sortDirection] = (params.sort ?? 'name:asc').split(':') as [
    string,
    'asc' | 'desc',
  ];

  return (
    <div className="p-6">
      <PageHeader
        title="Merchants"
        description="The merchant directory this tenant owns — merchants, their stores and the activities they participate in."
        actions={
          canCreate && (
            <Button type="button" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Add merchant
            </Button>
          )
        }
      />

      <form onSubmit={handleSearchSubmit} className="mb-4 flex max-w-sm gap-2">
        <Input
          label="Search"
          hideLabel
          placeholder="Search by code or name"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        <Button type="submit" variant="secondary">
          <Search className="size-4" aria-hidden="true" />
          Search
        </Button>
      </form>

      <Table
        caption="Merchants"
        columns={COLUMNS}
        data={data ? [...data.data] : []}
        getRowId={(row) => row.id}
        isLoading={isLoading}
        error={error instanceof ApiError ? error.message : null}
        emptyMessage="No merchants yet"
        emptyDescription={canCreate ? 'Add the first merchant to get started.' : undefined}
        sort={{ key: sortField, direction: sortDirection }}
        onSortChange={handleSortChange}
        onRowClick={(row) => navigate(`/merchants/${String(row.id)}`)}
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

      <AddMerchantModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
