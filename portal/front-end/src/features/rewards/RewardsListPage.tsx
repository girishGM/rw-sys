/**
 * T-032 — `/rewards`: the Rewards list (03-API-CONTRACT.md §9, 04-FRONTEND.md's
 * "Rewards list / editor | super_admin write | Reward system + connector config + policies").
 *
 * Reached through `router.tsx`'s `RequirePermission entity="reward" action="view"` guard.
 * Same two-control pattern `RulesListPage.tsx`'s own header documents: hiding "Add reward" is
 * UX, the matching `reward:create` permission row is what actually blocks the API either way
 * (TC-19: maker sees a read-only list, no create/edit controls rendered).
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import type { RewardListItem } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { Table, type TableColumn } from '../../components/Table';
import { useBootstrap } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';
import { AddRewardModal } from './AddRewardModal';
import { useRewardsQuery, type RewardListParams } from './api';

const COLUMNS: TableColumn<RewardListItem>[] = [
  { key: 'systemCode', header: 'Code', render: (row) => row.systemCode, sortable: true },
  { key: 'name', header: 'Name', render: (row) => row.name, sortable: true },
  { key: 'rewardType', header: 'Type', render: (row) => row.rewardType },
  { key: 'connectorType', header: 'Connector', render: (row) => row.connectorType },
  {
    key: 'status',
    header: 'Status',
    render: (row) => (
      <Badge tone={row.status === 'active' ? 'success' : 'slate'}>{row.status}</Badge>
    ),
    sortable: true,
  },
];

export function RewardsListPage() {
  const { hasPermission } = useBootstrap();
  const [params, setParams] = useState<RewardListParams>({ page: 1, sort: 'name:asc' });
  const [addOpen, setAddOpen] = useState(false);
  const navigate = useNavigate();

  const { data, isLoading, error } = useRewardsQuery(params);
  const canCreate = hasPermission('reward', 'create');

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
        title="Rewards"
        description="Global reward systems, authored once and assigned to the countries that use them."
        actions={
          canCreate && (
            <Button type="button" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Add reward
            </Button>
          )
        }
      />

      <Table
        caption="Rewards"
        columns={COLUMNS}
        data={data ? [...data.data] : []}
        getRowId={(row) => row.id}
        isLoading={isLoading}
        error={error instanceof ApiError ? error.message : null}
        emptyMessage="No rewards yet"
        emptyDescription={
          canCreate ? 'Add the first reward to get started.' : 'No rewards are assigned to you yet.'
        }
        sort={{ key: sortField, direction: sortDirection }}
        onSortChange={handleSortChange}
        onRowClick={(row) => navigate(`/rewards/${String(row.id)}`)}
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

      <AddRewardModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
