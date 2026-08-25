/**
 * T-042 — `/definition-requests`: the triage queue (06-VERSIONING.md §10). Reached through
 * `router.tsx`'s `RequirePermission entity="definition_request" action="view"` guard.
 *
 * Visibility is entirely the server's: `DefinitionRequestsService.list` already scopes a
 * `country_admin`/`tenant_admin` to their own requests (`ScopedRepository`), so this page never
 * branches on role for *which rows* it shows — only for whether "New request" is rendered at
 * all, the same two-control pattern `RulesListPage.tsx`'s own header documents.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import {
  DEFINITION_REQUEST_PRIORITIES,
  DEFINITION_REQUEST_STATUSES,
  type DefinitionRequest,
} from '@reward-portal/shared';
import { Badge, type BadgeTone } from '../../components/Badge';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { Select, type SelectOption } from '../../components/Select';
import { Table, type TableColumn } from '../../components/Table';
import { useBootstrap } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';
import { SubmitDefinitionRequestModal } from './SubmitDefinitionRequestModal';
import { useDefinitionRequestsQuery, type DefinitionRequestListParams } from './api';

const STATUS_TONE: Record<DefinitionRequest['status'], BadgeTone> = {
  submitted: 'sky',
  under_review: 'warning',
  approved: 'primary',
  rejected: 'danger',
  fulfilled: 'success',
  withdrawn: 'slate',
};

const STATUS_OPTIONS: SelectOption[] = [
  { value: '', label: 'All statuses' },
  ...DEFINITION_REQUEST_STATUSES.map((status) => ({ value: status, label: status })),
];

const PRIORITY_OPTIONS: SelectOption[] = [
  { value: '', label: 'All priorities' },
  ...DEFINITION_REQUEST_PRIORITIES.map((priority) => ({ value: priority, label: priority })),
];

const COLUMNS: TableColumn<DefinitionRequest>[] = [
  { key: 'title', header: 'Title', render: (row) => row.title },
  {
    key: 'requestType',
    header: 'Type',
    render: (row) => row.requestType.replace('_', ' '),
  },
  {
    key: 'priority',
    header: 'Priority',
    render: (row) => <Badge tone="slate">{row.priority}</Badge>,
  },
  {
    key: 'status',
    header: 'Status',
    render: (row) => <Badge tone={STATUS_TONE[row.status]}>{row.status.replace('_', ' ')}</Badge>,
  },
  {
    key: 'createdAt',
    header: 'Submitted',
    render: (row) => new Date(row.createdAt).toLocaleDateString(),
  },
];

export function DefinitionRequestsListPage() {
  const { hasPermission } = useBootstrap();
  const [params, setParams] = useState<DefinitionRequestListParams>({ page: 1 });
  const [addOpen, setAddOpen] = useState(false);
  const navigate = useNavigate();

  const { data, isLoading, error } = useDefinitionRequestsQuery(params);
  const canCreate = hasPermission('definition_request', 'create');

  return (
    <div className="p-6">
      <PageHeader
        title="Definition requests"
        description="Ask Super Admin for a new or changed rule/reward, and track it through to the version that fulfils it."
        actions={
          canCreate && (
            <Button type="button" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              New request
            </Button>
          )
        }
      />

      <div className="mb-4 grid max-w-md grid-cols-2 gap-4">
        <Select
          label="Status"
          hideLabel
          options={STATUS_OPTIONS}
          value={params.status ?? ''}
          onChange={(value) =>
            setParams((current) => ({
              ...current,
              page: 1,
              status: value === '' ? undefined : value,
            }))
          }
        />
        <Select
          label="Priority"
          hideLabel
          options={PRIORITY_OPTIONS}
          value={params.priority ?? ''}
          onChange={(value) =>
            setParams((current) => ({
              ...current,
              page: 1,
              priority: value === '' ? undefined : value,
            }))
          }
        />
      </div>

      <Table
        caption="Definition requests"
        columns={COLUMNS}
        data={data ? [...data.data] : []}
        getRowId={(row) => row.id}
        isLoading={isLoading}
        error={error instanceof ApiError ? error.message : null}
        emptyMessage="No definition requests yet"
        emptyDescription={
          canCreate
            ? 'Raise the first request to get started.'
            : 'No requests have been raised yet.'
        }
        onRowClick={(row) => navigate(`/definition-requests/${String(row.id)}`)}
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

      <SubmitDefinitionRequestModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
