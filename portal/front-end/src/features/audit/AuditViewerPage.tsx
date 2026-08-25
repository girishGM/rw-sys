/**
 * T-040 — `/audit`: the filterable, exportable audit viewer (04-FRONTEND.md §4, "Audit log |
 * per permission | Filterable, exportable").
 *
 * Reached through `router.tsx`'s `PROTECTED_ROUTE_SPECS` `/audit` row, already gated by
 * `<RequirePermission entity="audit" action="view">` — a maker or a merchant (neither granted
 * `audit:view`, `T004_001_seed_role_entity_permissions.ts`) never renders this component at all,
 * the same "door that will slam in their face" property 04-FRONTEND.md §2 describes for every
 * other guarded route. The `Portal audit log` tab below is a **second**, narrower gate on top of
 * that: only `super_admin` may see it, mirroring `audit-viewer.controller.ts`'s own
 * `@Roles('super_admin')` (no `role_entity_permissions` row exists for it, for any role).
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { DatePicker } from '../../components/DatePicker';
import { PageHeader } from '../../components/PageHeader';
import { Select, type SelectOption } from '../../components/Select';
import { Table, type TableColumn } from '../../components/Table';
import { Tabs } from '../../components/Tabs';
import { useBootstrap } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';
import {
  AUDIT_CAMPAIGNS_QUERY_KEY,
  AUDIT_PORTAL_QUERY_KEY,
  auditExportUrl,
  fetchCampaignAudit,
  fetchPortalAudit,
  type AuditFilters,
  type CampaignAuditRow,
  type PortalAuditRow,
} from './api';

const PAGE_SIZE = 20;

/** `CAMPAIGN_AUDIT_ACTION` / `CAMPAIGN_AUDIT_ENTITY_TYPE`, `back-end/src/common/audit/
 * audit.constants.ts` — transcribed here, not imported: the back end is a separate build target
 * with no runtime dependency between the two, the same relationship every other feature's
 * front-end filter list already has with its server-side enum (e.g. `list-countries-query.dto.ts`
 * / the country-status `Select` options). */
const ACTION_OPTIONS: SelectOption[] = [
  { value: 'created', label: 'Created' },
  { value: 'updated', label: 'Updated' },
  { value: 'deleted', label: 'Deleted' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'status_changed', label: 'Status changed' },
];

const ENTITY_TYPE_OPTIONS: SelectOption[] = [
  { value: 'campaign', label: 'Campaign' },
  { value: 'tracker', label: 'Tracker' },
  { value: 'tracker_component', label: 'Tracker component' },
  { value: 'rule_assignment', label: 'Rule assignment' },
  { value: 'reward_assignment', label: 'Reward assignment' },
  { value: 'cap_override', label: 'Cap override' },
  { value: 'entity_assignment', label: 'Entity assignment' },
  { value: 'campaign_submit', label: 'Campaign submit' },
  { value: 'campaign_approval', label: 'Campaign approval' },
];

interface FilterState {
  dateFrom: Date | null;
  dateTo: Date | null;
  action: string | null;
  entityType: string | null;
  eventType: string;
}

const EMPTY_FILTERS: FilterState = {
  dateFrom: null,
  dateTo: null,
  action: null,
  entityType: null,
  eventType: '',
};

function toIsoOrUndefined(date: Date | null): string | undefined {
  return date === null ? undefined : date.toISOString();
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'An unexpected error occurred.';
}

export function AuditViewerPage() {
  const { user } = useBootstrap();
  const isSuperAdmin = user?.role === 'super_admin';
  const [tab, setTab] = useState('campaigns');

  return (
    <div className="p-6">
      <PageHeader title="Audit log" description="Governance actions, filterable and exportable." />

      {isSuperAdmin ? (
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: 'campaigns', label: 'Campaign audit', panel: <CampaignAuditPanel /> },
            { value: 'portal', label: 'Portal audit log', panel: <PortalAuditPanel /> },
          ]}
        />
      ) : (
        <CampaignAuditPanel />
      )}
    </div>
  );
}

function CampaignAuditPanel() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);

  const query: AuditFilters = useMemo(
    () => ({
      dateFrom: toIsoOrUndefined(filters.dateFrom),
      dateTo: toIsoOrUndefined(filters.dateTo),
      action: filters.action ?? undefined,
      entityType: filters.entityType ?? undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    [filters, page],
  );

  const result = useQuery({
    queryKey: [...AUDIT_CAMPAIGNS_QUERY_KEY, query],
    queryFn: () => fetchCampaignAudit(query),
  });

  const columns: TableColumn<CampaignAuditRow>[] = [
    { key: 'performedAt', header: 'Performed', render: (row) => row.performedAt },
    { key: 'action', header: 'Action', render: (row) => row.action },
    { key: 'entityType', header: 'Entity', render: (row) => row.entityType },
    { key: 'performedBy', header: 'Performed by', render: (row) => `#${String(row.performedBy)}` },
    {
      key: 'comment',
      header: 'Comment',
      render: (row) => row.comment ?? '—',
    },
  ];

  return (
    <div className="space-y-4">
      <FilterBar>
        <DatePicker
          label="From"
          value={filters.dateFrom}
          onChange={(date) => {
            setPage(1);
            setFilters((prev) => ({ ...prev, dateFrom: date }));
          }}
        />
        <DatePicker
          label="To"
          value={filters.dateTo}
          onChange={(date) => {
            setPage(1);
            setFilters((prev) => ({ ...prev, dateTo: date }));
          }}
        />
        <Select
          label="Action"
          value={filters.action}
          onChange={(value) => {
            setPage(1);
            setFilters((prev) => ({ ...prev, action: value }));
          }}
          options={ACTION_OPTIONS}
          placeholder="Any action"
        />
        <Select
          label="Entity type"
          value={filters.entityType}
          onChange={(value) => {
            setPage(1);
            setFilters((prev) => ({ ...prev, entityType: value }));
          }}
          options={ENTITY_TYPE_OPTIONS}
          placeholder="Any entity"
        />
        <ExportLink scope="campaigns" filters={query} />
      </FilterBar>

      <Table
        caption="Campaign audit trail"
        columns={columns}
        data={[...(result.data?.data ?? [])]}
        getRowId={(row) => row.id}
        isLoading={result.isLoading}
        error={result.isError ? errorMessage(result.error) : null}
        emptyMessage="No audit rows"
        emptyDescription="No campaign audit events match these filters."
      />

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={result.data?.meta.total ?? 0}
        onChange={setPage}
      />
    </div>
  );
}

function PortalAuditPanel() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);

  const query: AuditFilters = useMemo(
    () => ({
      dateFrom: toIsoOrUndefined(filters.dateFrom),
      dateTo: toIsoOrUndefined(filters.dateTo),
      eventType: filters.eventType.length > 0 ? filters.eventType : undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    [filters, page],
  );

  const result = useQuery({
    queryKey: [...AUDIT_PORTAL_QUERY_KEY, query],
    queryFn: () => fetchPortalAudit(query),
  });

  const columns: TableColumn<PortalAuditRow>[] = [
    { key: 'occurredAt', header: 'Occurred', render: (row) => row.occurredAt },
    { key: 'eventType', header: 'Event', render: (row) => row.eventType },
    {
      key: 'actor',
      header: 'Actor',
      render: (row) =>
        `${row.actorRole ?? '—'} ${row.actorId !== null ? `(#${String(row.actorId)})` : ''}`,
    },
    { key: 'ipAddress', header: 'IP', render: (row) => row.ipAddress ?? '—' },
  ];

  return (
    <div className="space-y-4">
      <FilterBar>
        <DatePicker
          label="From"
          value={filters.dateFrom}
          onChange={(date) => {
            setPage(1);
            setFilters((prev) => ({ ...prev, dateFrom: date }));
          }}
        />
        <DatePicker
          label="To"
          value={filters.dateTo}
          onChange={(date) => {
            setPage(1);
            setFilters((prev) => ({ ...prev, dateTo: date }));
          }}
        />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">Event type</span>
          <input
            type="text"
            value={filters.eventType}
            onChange={(event) => {
              setPage(1);
              setFilters((prev) => ({ ...prev, eventType: event.target.value }));
            }}
            placeholder="login_succeeded"
            className="rounded-control border border-slate-300 px-2.5 py-1.5 text-sm"
          />
        </label>
        <ExportLink scope="portal" filters={query} />
      </FilterBar>

      <Table
        caption="Portal audit log"
        columns={columns}
        data={[...(result.data?.data ?? [])]}
        getRowId={(row) => row.id}
        isLoading={result.isLoading}
        error={result.isError ? errorMessage(result.error) : null}
        emptyMessage="No audit rows"
        emptyDescription="No authentication or access-control events match these filters."
      />

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={result.data?.meta.total ?? 0}
        onChange={setPage}
      />
    </div>
  );
}

function FilterBar({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-end gap-3">{children}</div>;
}

function ExportLink({ scope, filters }: { scope: 'campaigns' | 'portal'; filters: AuditFilters }) {
  return (
    <a
      href={auditExportUrl(scope, filters)}
      className="ml-auto inline-flex items-center gap-1.5 self-end rounded-control border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
    >
      <Download className="size-4" aria-hidden="true" />
      Export CSV
    </a>
  );
}

function Pagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between text-sm text-slate-600">
      <span>{total} total</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="rounded-control border border-slate-300 px-2.5 py-1 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Previous
        </button>
        <span>
          Page {page} of {lastPage}
        </span>
        <button
          type="button"
          onClick={() => onChange(Math.min(lastPage, page + 1))}
          disabled={page >= lastPage}
          className="rounded-control border border-slate-300 px-2.5 py-1 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}
