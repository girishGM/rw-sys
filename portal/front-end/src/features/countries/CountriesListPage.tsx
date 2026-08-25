/**
 * T-030 — `/countries`: the Countries list (03-API-CONTRACT.md §5, 04-FRONTEND.md's
 * "Countries list / detail | super_admin | Onboard country → then 'Create Country Admin'").
 *
 * Reached through `router.tsx`'s `RequirePermission entity="country" action="view"` guard —
 * everyone who can navigate here can already see every row scope allows (`country_admin` sees
 * only its own country; `CountriesService.list`'s own header explains why no client-side branch
 * is needed for that). "Add country" is gated a second, independent time here, on
 * `country:create`, exactly as 00-ARCHITECTURE.md §7 requires: "the matching server-side
 * permission row is what actually blocks the API. Hiding a link never stands alone as a
 * control" — the button is hidden *and* the server would 403 a `country_admin` who forged the
 * request anyway (T-030 TC-8).
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import type { Country } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { Table, type TableColumn } from '../../components/Table';
import { useBootstrap } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';
import { AddCountryModal } from './AddCountryModal';
import { useCountriesQuery, type CountryListParams } from './api';

const COLUMNS: TableColumn<Country>[] = [
  { key: 'code', header: 'Code', render: (row) => row.code, sortable: true },
  { key: 'name', header: 'Name', render: (row) => row.name, sortable: true },
  {
    key: 'isHq',
    header: 'HQ',
    render: (row) => (row.isHq ? <Badge tone="primary">HQ</Badge> : null),
  },
  {
    key: 'status',
    header: 'Status',
    render: (row) => (
      <Badge tone={row.status === 'active' ? 'success' : 'slate'}>{row.status}</Badge>
    ),
    sortable: true,
  },
];

export function CountriesListPage() {
  const { hasPermission } = useBootstrap();
  const [params, setParams] = useState<CountryListParams>({ page: 1, sort: 'name:asc' });
  const [addOpen, setAddOpen] = useState(false);
  const navigate = useNavigate();

  const { data, isLoading, error } = useCountriesQuery(params);
  const canCreate = hasPermission('country', 'create');

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
        title="Countries"
        description="Onboard a country, then its Country Admin."
        actions={
          canCreate && (
            <Button type="button" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Add country
            </Button>
          )
        }
      />

      <Table
        caption="Countries"
        columns={COLUMNS}
        data={data ? [...data.data] : []}
        getRowId={(row) => row.id}
        isLoading={isLoading}
        error={error instanceof ApiError ? error.message : null}
        emptyMessage="No countries yet"
        emptyDescription={canCreate ? 'Add the first country to get started.' : undefined}
        sort={{ key: sortField, direction: sortDirection }}
        onSortChange={handleSortChange}
        onRowClick={(row) => navigate(`/countries/${String(row.id)}`)}
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

      <AddCountryModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
