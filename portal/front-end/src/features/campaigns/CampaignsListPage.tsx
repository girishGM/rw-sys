/**
 * T-037 — `/campaigns`: the campaign list (04-FRONTEND.md §4, "Campaign wizard | maker").
 *
 * Visibility is entirely the server's: `CampaignsService.list` scopes through
 * `ScopedRepository`, so this page never branches on role for *which rows* it shows — only for
 * whether "New campaign" is rendered, which is the same two-control pattern
 * `RulesListPage.tsx`'s header documents. Hiding the control is UX; the `campaign:create`
 * permission row is what actually blocks the API.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import type { Campaign } from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { Table, type TableColumn } from '../../components/Table';
import { useBootstrap } from '../../auth/useBootstrap';
import { CampaignStatusPill } from './CampaignStatusPill';
import { formatCalendarDateRange } from './campaignDate';
import { useCampaignsQuery, type CampaignListParams } from './api';

const COLUMNS: TableColumn<Campaign>[] = [
  { key: 'campaignCode', header: 'Code', render: (row) => row.campaignCode, sortable: true },
  { key: 'name', header: 'Name', render: (row) => row.name, sortable: true },
  {
    key: 'startDate',
    header: 'Runs',
    // T-065 — the same formatter the wizard's review step and the detail view use, so the three
    // cannot show a maker three different days for one campaign.
    render: (row) => formatCalendarDateRange(row.startDate, row.endDate),
    sortable: true,
  },
  {
    key: 'budget',
    header: 'Budget',
    render: (row) =>
      row.budgetAmount === null ? '—' : `${row.budgetAmount} ${row.budgetCurrency ?? ''}`,
  },
  {
    key: 'status',
    header: 'Status',
    render: (row) => <CampaignStatusPill status={row.effectiveStatus} />,
    sortable: true,
  },
];

export function CampaignsListPage() {
  const { hasPermission } = useBootstrap();
  const [params, setParams] = useState<CampaignListParams>({ page: 1, sort: 'createdAt:desc' });
  const navigate = useNavigate();

  const { data, isLoading, error } = useCampaignsQuery(params);
  const canCreate = hasPermission('campaign', 'create');

  function handleSortChange(key: string): void {
    setParams((current) => {
      const [currentField, currentDirection] = (current.sort ?? 'createdAt:desc').split(':');
      const direction = currentField === key && currentDirection === 'asc' ? 'desc' : 'asc';
      return { ...current, page: 1, sort: `${key}:${direction}` };
    });
  }

  const [sortField, sortDirection] = (params.sort ?? 'createdAt:desc').split(':') as [
    string,
    'asc' | 'desc',
  ];

  return (
    <div className="p-6">
      <PageHeader
        title="Campaigns"
        description="Every campaign in your tenant, and the wizard that builds them."
        actions={
          canCreate && (
            <Button
              type="button"
              onClick={() => {
                navigate('/campaigns/new');
              }}
            >
              <Plus className="size-4" aria-hidden="true" />
              New campaign
            </Button>
          )
        }
      />

      <Table
        caption="Campaigns"
        columns={COLUMNS}
        data={[...(data?.data ?? [])]}
        getRowId={(row) => row.id}
        isLoading={isLoading}
        error={error === null ? null : error.message}
        sort={{ key: sortField, direction: sortDirection }}
        onSortChange={handleSortChange}
        onRowClick={(row) => {
          navigate(`/campaigns/${String(row.id)}`);
        }}
        emptyMessage="No campaigns yet"
        emptyDescription="Create one to start building a customer journey."
      />
    </div>
  );
}
