/**
 * T-INT-031 — `list_campaign_reward_progress`: the per-campaign detail behind
 * `RewardTrackingSummaryWidget.tsx`'s own headline count. Same data source (`GET /dashboard/
 * reward-tracking/alerts`, `REWARD_TRACKING_ALERTS_QUERY_KEY` — TanStack Query coalesces both
 * widgets' fetches into one real network call), rendered as one row per flagged budget/cap group
 * (TC-5) via the shared `Table`, matching `ListWidget.tsx`'s own four-state shape (loading / error
 * / empty / populated) rather than reinventing it.
 *
 * ### Note 2 finding — no campaign pause/status-change control exists anywhere in portal's UI today
 *
 * The task brief asks this widget to surface, next to a flagged alert, "an existing campaign pause/
 * status-change action... if one already exists elsewhere in portal's campaign UI." It does **not**,
 * despite the state machine and the API route both being fully built:
 * `campaign-state-machine.ts` defines a real `active --pause--> paused` transition, and
 * `campaigns.controller.ts` exposes it as a real, permission-gated `POST /campaigns/:id/pause`
 * (added by `T-047`/`T047_003`, granted to `tenant_admin`) — but grepping every file under
 * `front-end/src/features/campaigns/` (the wizard, the list, the detail page, `api.ts`) turns up
 * zero calls to `/pause` or `/resume` and zero button/control anywhere that would trigger one. The
 * capability is real on the wire; there is no front-end surface for a human to reach it.
 *
 * Per the task's own instruction for this exact case ("if none exists at all: do not build new
 * campaign-lifecycle logic... leave the new widget's alert display read-only"), this widget does
 * **not** add a first-ever pause button — that would be new campaign-lifecycle UI built from this
 * task's own narrower scope, explicitly out of bounds. Each row instead links to the existing
 * `/campaigns` list (`CampaignsListPage`, where the flagged campaign's own status pill is visible
 * and a tenant_admin/maker/checker can locate and open it) as the closest already-built, reachable
 * context — not a claim that a pause action is reachable from there today. **Flagged here, and in
 * this task's own completion report, as a genuine finding for the architect**, exactly as note 2
 * asks: a real backend capability with no front-end entry point is a gap worth its own follow-up
 * task, not something this widget should paper over by inventing the first one.
 */
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card, CardBody, CardHeader } from '../../../components/Card';
import { Table, type TableColumn } from '../../../components/Table';
import {
  fetchRewardTrackingAlerts,
  REWARD_TRACKING_ALERTS_QUERY_KEY,
  type RewardAlert,
} from './RewardTrackingSummaryWidget';
import type { WidgetProps } from './types';

interface AlertRow {
  readonly id: string;
  readonly campaignCode: string;
  readonly rewardCategory: string;
  readonly consumptionPercent: number;
  readonly warnAtPercent: number;
}

function toRow(alert: RewardAlert): AlertRow {
  return {
    id: `${alert.campaignCode}:${alert.rewardCategory}:${alert.rewardKind}`,
    campaignCode: alert.campaignCode,
    rewardCategory: alert.rewardCategory,
    consumptionPercent: alert.consumptionPercent,
    warnAtPercent: alert.warnAtPercent,
  };
}

const COLUMNS: TableColumn<AlertRow>[] = [
  {
    key: 'campaign',
    header: 'Campaign',
    render: (row) => (
      <div>
        <div className="font-medium text-slate-800">{row.campaignCode}</div>
        <div className="text-xs text-slate-500">
          {row.rewardCategory} · {row.consumptionPercent}% of cap (warns at {row.warnAtPercent}%)
        </div>
      </div>
    ),
  },
];

export function CampaignProgressWidget({ label }: WidgetProps) {
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: REWARD_TRACKING_ALERTS_QUERY_KEY,
    queryFn: fetchRewardTrackingAlerts,
  });

  const rows = (data ?? []).map(toRow);

  return (
    <Card>
      <CardHeader>
        {/* `h2` — see `ListWidget.tsx`'s identical comment: the page's one `h1` is
            `PageHeader`'s title, so a widget tile's heading is the next level, not `h3`. */}
        <h2 className="text-sm font-medium text-slate-700">{label}</h2>
      </CardHeader>
      <CardBody>
        <Table<AlertRow>
          caption={label}
          columns={COLUMNS}
          data={rows}
          getRowId={(row) => row.id}
          isLoading={isLoading}
          error={isError ? (error.message ?? "Couldn't load campaign reward progress.") : null}
          emptyMessage="No campaigns are near a budget or cap threshold"
          skeletonRowCount={3}
          // Note 2: the closest already-built, reachable venue — not a claim a pause control
          // exists there today. See this file's own header for the full finding.
          onRowClick={() => {
            navigate('/campaigns');
          }}
        />
      </CardBody>
    </Card>
  );
}
