/**
 * T-INT-031 — the first widget sourced from `reward-service-integration-plan`'s own T-INT-030
 * backend proxy (`GET /dashboard/reward-tracking/alerts`, `reward-tracking-dashboard.controller.ts`),
 * not from the generic `GET /dashboard/widgets/:widgetKey` route every other widget in this folder
 * uses (`./api.ts`) — that route only ever serves data shaped for `role_dashboard_widgets`' own
 * generic per-widget-key contract, and T-INT-030's proxy has its own, separate, already-scoped
 * REST surface. This widget therefore fetches directly, matching the shape of `createKpiWidget`
 * (loading/error/value/trend) without going through that factory.
 *
 * **Why `alerts`, not one of the four other `summary` endpoints, for a widget every one of the
 * six roles can see:** `admin-rewards.controller.ts`'s own header (read directly before picking this
 * endpoint) documents that only `alerts` is genuinely scoped correctly for every role today —
 * `tenants/:id/summary` needs a concrete `tenantId` the caller must already know, `merchants/:code/
 * summary` needs a `merchantCode` this SPA's own bootstrap payload never carries (only the numeric
 * `merchantId`, see `packages/shared/src/bootstrap.schema.ts`), and `countries/:code/summary` is
 * flatly rejected for anyone but `super_admin` (a documented, unresolved RTS-side gap, not this
 * widget's to work around). `alerts` needs no path parameter at all — RTS resolves the caller's own
 * `tenantId`/`countryId`/`merchantId` straight off the minted token
 * (`alerts-query.service.ts#findCandidateCampaigns`) — so it is the one endpoint this widget can
 * call identically for every role and still get a correctly-scoped answer (TC-1/TC-2/TC-6).
 *
 * `RewardAlert`/`fetchRewardTrackingAlerts`/`REWARD_TRACKING_ALERTS_QUERY_KEY` are exported for
 * `CampaignProgressWidget.tsx` (this task's other new widget) to reuse — both widgets query the
 * exact same endpoint with the exact same `queryKey`, so TanStack Query's own cache coalesces the
 * two into a single network call rather than firing it twice per dashboard render.
 */
import { useQuery } from '@tanstack/react-query';
import { Gift } from 'lucide-react';
import { api } from '../../../lib/apiClient';
import { toApiError } from '../../../lib/apiError';
import { KpiTile } from '../../../components/KpiTile';
import { WidgetErrorTile } from './WidgetError';
import type { WidgetProps } from './types';

/**
 * One row of RTS's `GET /reward-tracking/alerts` response, forwarded verbatim by T-INT-030's
 * proxy (`RewardTrackingProxyResponse` — a passthrough, deliberately untyped on the back-end side;
 * see that client's own header for why). Mirrors `reward-tracking-service/src/modules/api/
 * alerts-query.service.ts`'s own exported `RewardAlert` interface — copied here rather than
 * imported across a service boundary this repo has no shared-types package for (the same
 * arm's-length convention `reward-tracking-rest.client.ts` itself already uses for this exact
 * response body).
 */
export interface RewardAlert {
  readonly campaignCode: string;
  readonly tenantId: number;
  readonly rewardCategory: string;
  readonly rewardKind: 'FIXED_AMOUNT' | 'POINTS';
  readonly totalValue: string;
  readonly totalCount: number;
  readonly capMaxTotalAmount: string;
  readonly consumptionPercent: number;
  readonly warnAtPercent: number;
  readonly warnTriggered: boolean;
}

export const REWARD_TRACKING_ALERTS_QUERY_KEY = ['dashboard-reward-tracking-alerts'] as const;

/**
 * Every row RTS's own `AlertsQueryService#listAlerts` returns is already `warnTriggered: true`
 * (it filters before pushing — see that file's own loop) — this fetch does not re-filter.
 *
 * T-INT-031: this task's own "Files owned" list permits exactly two new front-end files (this one
 * and `CampaignProgressWidget.tsx`), both widget components; sharing the fetch/type/queryKey
 * between them without a third, non-component-only file means this one file mixes a component
 * export with plain function/type/constant exports, which is exactly what the disabled rule below
 * warns about — a real concern for hot-reload behavior in the general case, not a correctness
 * issue here.
 */
// eslint-disable-next-line react-refresh/only-export-components -- see the comment immediately above
export async function fetchRewardTrackingAlerts(): Promise<RewardAlert[]> {
  try {
    const response = await api.get<{ data: { alerts: RewardAlert[] } }>(
      '/dashboard/reward-tracking/alerts',
    );
    return response.data.data.alerts;
  } catch (error) {
    throw toApiError(error);
  }
}

/** The single highest `consumptionPercent` alert, or `null` for an empty list — used for the
 * KPI tile's own trend line (the number a viewer most wants to see is the *closest to its cap*,
 * not an arbitrary first element). */
function highestConsumption(alerts: readonly RewardAlert[]): RewardAlert | null {
  return alerts.reduce<RewardAlert | null>(
    (max, alert) =>
      max === null || alert.consumptionPercent > max.consumptionPercent ? alert : max,
    null,
  );
}

/**
 * `kpi_reward_tracking_alerts` — how many of the caller's own visible campaigns currently have a
 * budget/cap group over its configured warn threshold, per RTS's own real-time counters. Every
 * `RewardAlert` this widget ever sees is already scoped to the caller's own role by RTS itself
 * (this widget applies no client-side filtering of its own — implementation note 3: "a display
 * convenience on top of an already-enforced server boundary, never the only enforcement").
 */
export function RewardTrackingSummaryWidget({ label }: WidgetProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: REWARD_TRACKING_ALERTS_QUERY_KEY,
    queryFn: fetchRewardTrackingAlerts,
  });

  if (isError) {
    return <WidgetErrorTile label={label} />;
  }

  const alerts = data ?? [];
  const worst = highestConsumption(alerts);

  return (
    <KpiTile
      label={label}
      value={data === undefined ? '—' : alerts.length}
      icon={Gift}
      trend={
        worst === null
          ? undefined
          : {
              direction: 'up',
              value: `${String(worst.consumptionPercent)}%`,
              label: `${worst.campaignCode} nearest its cap`,
            }
      }
      isLoading={isLoading}
    />
  );
}
