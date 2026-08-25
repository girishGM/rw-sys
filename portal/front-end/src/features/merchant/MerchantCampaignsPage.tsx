/**
 * T-039 — `/merchant/campaigns` (04-FRONTEND.md §2: "merchant" is the only role guarded onto this
 * route). One screen: the participation-scoped campaign list, a summary strip of the three
 * widgets 01-DATABASE.md §5.3 seeds for this role (TC-13), and a campaign's detail as a `Drawer`
 * rather than a separate route — 04-FRONTEND.md §2's own route table lists `/merchant/campaigns`
 * with no `:id` child, unlike every list+detail pair above it in the same table (`/merchants,
 * /merchants/:id`, `/tenants, /tenants/:id`, …), so the detail view stays on this URL by design.
 *
 * Reached through `router.tsx`'s `RequirePermission entity="campaign" action="view"` guard —
 * everyone who can navigate here already sees only what `ScopedRepository`'s `merchant` scope
 * rule allows (`merchant-portal.service.ts`'s own header): its own tenant, its own participation.
 * There is no client-side filtering here to get wrong (TC-2's isolation is a server property).
 */
import { useState } from 'react';
import { AlertCircle, Ban, ClipboardList } from 'lucide-react';
import type { MerchantCampaignListItem } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Chart } from '../../components/Chart';
import { Drawer } from '../../components/Drawer';
import { EmptyState } from '../../components/EmptyState';
import { KpiTile } from '../../components/KpiTile';
import { PageHeader } from '../../components/PageHeader';
import { Skeleton } from '../../components/Skeleton';
import { Table, type TableColumn } from '../../components/Table';
import { ApiError } from '../../lib/apiError';
import {
  useMerchantCampaignQuery,
  useMerchantCampaignsQuery,
  useMerchantSummaryQuery,
} from './api';

const STATUS_TONE: Record<MerchantCampaignListItem['status'], 'success' | 'slate' | 'sky'> = {
  active: 'success',
  paused: 'slate',
  completed: 'sky',
};

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const COLUMNS: TableColumn<MerchantCampaignListItem>[] = [
  { key: 'campaignCode', header: 'Code', render: (row) => row.campaignCode },
  { key: 'name', header: 'Name', render: (row) => row.name },
  { key: 'region', header: 'Region', render: (row) => row.region ?? '—' },
  {
    key: 'status',
    header: 'Status',
    render: (row) => <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>,
  },
  {
    key: 'startDate',
    header: 'Starts',
    render: (row) => formatDate(row.startDate),
  },
  {
    key: 'endDate',
    header: 'Ends',
    render: (row) => formatDate(row.endDate),
  },
];

/** The dashboard summary strip — implementation note 5/6, TC-13, TC-18, TC-19. Backed by this
 * task's own `GET /merchant/summary` rather than T-023's generic per-widget endpoint, which has
 * no backing route yet for any role (`dashboard/widgets/api.ts`'s own header discloses that gap);
 * this strip is therefore genuinely live against the real database today. */
function SummaryStrip() {
  const { data, isLoading, isError } = useMerchantSummaryQuery();

  if (isError) {
    return (
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <EmptyState icon={AlertCircle} message="Could not load your dashboard summary" />
      </div>
    );
  }

  return (
    <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <KpiTile
        label="Active Campaigns"
        value={data?.activeCampaignsCount ?? '—'}
        isLoading={isLoading}
      />
      <KpiTile label="My Activities" value={data?.myActivitiesCount ?? '—'} isLoading={isLoading} />
      <div className="flex flex-col gap-2 rounded-card border border-slate-200 bg-white p-4 shadow-card">
        <span className="text-sm font-medium text-slate-500">Campaign Performance</span>
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : data && data.campaignPerformance.available ? (
          <Chart
            title="Campaign Performance"
            data={data.campaignPerformance.series.map((point) => ({
              label: point.label,
              value: point.value,
            }))}
          />
        ) : (
          // TC-19 — an honest "not available" state, never a fabricated `0` or series.
          <p className="py-4 text-sm text-slate-500">
            {data?.campaignPerformance.available === false
              ? data.campaignPerformance.reason
              : 'Not available'}
          </p>
        )}
      </div>
    </div>
  );
}

function CampaignDetailDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { data, isLoading, isError, error } = useMerchantCampaignQuery(id);

  return (
    <Drawer open={id !== null} onClose={onClose} title={data?.name ?? 'Campaign'} width="lg">
      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : isError || data === undefined ? (
        <EmptyState
          icon={Ban}
          message="Could not load this campaign"
          description={error instanceof ApiError ? error.message : undefined}
        />
      ) : (
        <div className="space-y-6 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[data.status]}>{data.status}</Badge>
            <span className="text-slate-500">{data.campaignCode}</span>
          </div>

          {data.description && <p className="text-slate-700">{data.description}</p>}

          <dl className="grid grid-cols-2 gap-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Region</dt>
              <dd className="mt-0.5 text-slate-900">{data.region ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Runs</dt>
              <dd className="mt-0.5 text-slate-900">
                {formatDate(data.startDate)} – {formatDate(data.endDate)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">
                My participation status
              </dt>
              <dd className="mt-0.5 text-slate-900">{data.participation.status}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Joined</dt>
              <dd className="mt-0.5 text-slate-900">{formatDate(data.participation.joinedAt)}</dd>
            </div>
          </dl>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-900">My Activities</h3>
            {data.myActivities.length === 0 ? (
              <EmptyState
                icon={ClipboardList}
                message="No activities linked to this campaign yet"
              />
            ) : (
              <ul className="divide-y divide-slate-100">
                {data.myActivities.map((activity) => (
                  <li
                    key={`${String(activity.activityId)}-${String(activity.storeId)}`}
                    className="flex items-center justify-between py-2"
                  >
                    <span>
                      {activity.activityName}
                      {activity.storeId === null
                        ? ' · tenant-wide'
                        : ` · store #${String(activity.storeId)}`}
                    </span>
                    <span className="text-slate-500">
                      {activity.commissionRate === null ? '—' : `${activity.commissionRate}%`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

export function MerchantCampaignsPage() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const { data, isLoading, error } = useMerchantCampaignsQuery();

  return (
    <div className="p-6">
      <PageHeader
        title="My Campaigns"
        description="Campaigns your activities participate in — read-only."
      />

      <SummaryStrip />

      <Table
        caption="My campaigns"
        columns={COLUMNS}
        data={data ? [...data] : []}
        getRowId={(row) => row.id}
        isLoading={isLoading}
        error={error instanceof ApiError ? error.message : null}
        emptyMessage="You are not participating in any campaign yet"
        emptyDescription="Once a tenant admin adds one of your activities to a campaign, it will show up here."
        onRowClick={(row) => setSelectedId(row.id)}
      />

      <CampaignDetailDrawer id={selectedId} onClose={() => setSelectedId(null)} />
    </div>
  );
}
