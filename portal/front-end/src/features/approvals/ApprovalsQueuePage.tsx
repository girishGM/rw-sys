/**
 * T-038 — `/approvals`: the checker's queue (04-FRONTEND.md §4, *"Approval queue | checker |
 * Table + side-by-side diff panel"*).
 *
 * Visibility is entirely the server's: `ApprovalsService.list` scopes through `ScopedRepository`,
 * so this page never branches on role for *which rows* it shows. What it does branch on is
 * `decidable` — the per-row fact the server computed from the verified JWT — and that governs one
 * thing only: whether the row advertises an action. Hiding a button is UX; the 422/403/409 the
 * server answers a `curl` with is the control (TC-6, TC-17).
 *
 * ### Why the default filter is `pending`
 *
 * A queue is a list of work, and 200 decided requests above the one waiting is not a queue. The
 * other four statuses stay one click away rather than hidden, because "what happened to my
 * submission" is the second question anyone asks here.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ApprovalRequest, ApprovalStatus } from '@reward-portal/shared';
import { APPROVAL_STATUSES } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { PageHeader } from '../../components/PageHeader';
import { Select } from '../../components/Select';
import { Table, type TableColumn } from '../../components/Table';
import { ApprovalStatusPill } from './ApprovalStatusPill';
import { useApprovalsQuery, type ApprovalListParams } from './api';

const PAGE_SIZE = 20;

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

const COLUMNS: TableColumn<ApprovalRequest>[] = [
  {
    key: 'subject',
    header: 'Campaign',
    render: (row) =>
      row.subject === null ? (
        // The subject is `null` when the campaign is gone or out of scope — the request row is
        // still governance evidence and must stay readable.
        <span className="text-slate-500">Campaign unavailable</span>
      ) : (
        <span>
          <span className="font-medium text-slate-800">{row.subject.campaignName}</span>{' '}
          <span className="text-slate-500">({row.subject.campaignCode})</span>
        </span>
      ),
  },
  {
    key: 'requestedBy',
    header: 'Submitted by',
    render: (row) => row.requestedByName ?? `User ${String(row.requestedBy)}`,
  },
  { key: 'requestedAt', header: 'Submitted', render: (row) => formatDate(row.requestedAt) },
  { key: 'expiresAt', header: 'Expires', render: (row) => formatDate(row.expiresAt) },
  {
    key: 'status',
    header: 'Status',
    render: (row) => (
      <span className="inline-flex items-center gap-2">
        <ApprovalStatusPill status={row.effectiveStatus} />
        {row.selfSubmitted && (
          // Named, not merely disabled: a checker who submitted this needs to know *why* they
          // cannot act on it, or they will file a bug against the button.
          <Badge tone="slate">Your submission</Badge>
        )}
      </span>
    ),
  },
];

export function ApprovalsQueuePage() {
  const [params, setParams] = useState<ApprovalListParams>({
    page: 1,
    pageSize: PAGE_SIZE,
    status: 'pending',
  });
  const navigate = useNavigate();
  const { data, isLoading, error } = useApprovalsQuery(params);

  const total = data?.meta.total ?? 0;
  const page = data?.meta.page ?? 1;
  const lastPage = Math.max(1, Math.ceil(total / (data?.meta.pageSize ?? PAGE_SIZE)));

  return (
    <div className="p-6">
      <PageHeader
        title="Approvals"
        description="Campaigns submitted for review in your tenant."
        actions={
          <Select
            label="Status"
            className="w-48"
            value={params.status ?? ''}
            onChange={(status) => {
              setParams((current) => ({
                ...current,
                page: 1,
                status: status === '' ? undefined : status,
              }));
            }}
            options={[
              { value: '', label: 'All statuses' },
              ...APPROVAL_STATUSES.map((status: ApprovalStatus) => ({
                value: status,
                label: status.charAt(0).toUpperCase() + status.slice(1),
              })),
            ]}
          />
        }
      />

      <Table
        caption="Approval requests"
        columns={COLUMNS}
        data={[...(data?.data ?? [])]}
        getRowId={(row) => row.id}
        isLoading={isLoading}
        error={error === null ? null : error.message}
        onRowClick={(row) => {
          navigate(`/approvals/${String(row.id)}`);
        }}
        emptyMessage="Nothing waiting for review"
        emptyDescription="Campaigns submitted by your tenant's makers will appear here."
      />

      {total > (data?.meta.pageSize ?? PAGE_SIZE) && (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
          <p className="text-slate-600">
            Page {page} of {lastPage} · {total} request{total === 1 ? '' : 's'}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-control border border-slate-300 px-3 py-1.5 disabled:opacity-50"
              disabled={page <= 1}
              onClick={() => {
                setParams((current) => ({
                  ...current,
                  page: Math.max(1, (current.page ?? 1) - 1),
                }));
              }}
            >
              Previous
            </button>
            <button
              type="button"
              className="rounded-control border border-slate-300 px-3 py-1.5 disabled:opacity-50"
              disabled={page >= lastPage}
              onClick={() => {
                setParams((current) => ({ ...current, page: (current.page ?? 1) + 1 }));
              }}
            >
              Next
            </button>
          </div>
        </nav>
      )}
    </div>
  );
}
