/**
 * T-031 — `/rules`: the Rules list (03-API-CONTRACT.md §8, 04-FRONTEND.md's
 * "Rules list / editor | super_admin write | Category → sub-category → expression + parameter
 * schema builder").
 *
 * Reached through `router.tsx`'s `RequirePermission entity="rule" action="view"` guard.
 * Visibility is entirely the server's: `RulesService.list` already scopes a `country_admin`/
 * `maker`/etc. to their own country's assigned rules (`ScopedRepository`), so this page never
 * branches on role for *which rows* it shows — only for whether "Add rule" is rendered at all
 * (TC-23: "UI as maker on /rules → read-only; no Create or Edit control rendered"; TC-24: "UI as
 * super_admin → full CRUD available"), exactly the two-control pattern
 * `CountriesListPage.tsx`'s own header documents: hiding the control is UX, the matching
 * `rule:create` permission row is what actually blocks the API either way.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import type { Rule } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { Table, type TableColumn } from '../../components/Table';
import { useBootstrap } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';
import { AddRuleModal } from './AddRuleModal';
import { useRulesQuery, type RuleListParams } from './api';

const COLUMNS: TableColumn<Rule>[] = [
  { key: 'ruleCode', header: 'Code', render: (row) => row.ruleCode, sortable: true },
  { key: 'name', header: 'Name', render: (row) => row.name, sortable: true },
  { key: 'category', header: 'Category', render: (row) => row.categoryName },
  { key: 'subCategory', header: 'Sub-category', render: (row) => row.subCategoryName },
  {
    key: 'status',
    header: 'Status',
    render: (row) => (
      <Badge tone={row.status === 'active' ? 'success' : 'slate'}>{row.status}</Badge>
    ),
    sortable: true,
  },
];

export function RulesListPage() {
  const { hasPermission } = useBootstrap();
  const [params, setParams] = useState<RuleListParams>({ page: 1, sort: 'name:asc' });
  const [addOpen, setAddOpen] = useState(false);
  const navigate = useNavigate();

  const { data, isLoading, error } = useRulesQuery(params);
  const canCreate = hasPermission('rule', 'create');

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
        title="Rules"
        description="Global rules, authored once and assigned to the countries that use them."
        actions={
          canCreate && (
            <Button type="button" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Add rule
            </Button>
          )
        }
      />

      <Table
        caption="Rules"
        columns={COLUMNS}
        data={data ? [...data.data] : []}
        getRowId={(row) => row.id}
        isLoading={isLoading}
        error={error instanceof ApiError ? error.message : null}
        emptyMessage="No rules yet"
        emptyDescription={
          canCreate ? 'Add the first rule to get started.' : 'No rules are assigned to you yet.'
        }
        sort={{ key: sortField, direction: sortDirection }}
        onSortChange={handleSortChange}
        onRowClick={(row) => navigate(`/rules/${String(row.id)}`)}
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

      <AddRuleModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
