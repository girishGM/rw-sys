/**
 * T-023 — `WIDGET_REGISTRY` (04-FRONTEND.md §3): every seeded `widget_key`
 * (01-DATABASE.md §5.3 / `back-end/src/database/migrations/T004_003_seed_role_dashboard_widgets.ts`)
 * mapped to the component that renders it. `DashboardPage` looks a widget up here by
 * `widget_key` and renders `null` for anything missing (TC-10) — **never** restructure this
 * file; append one line per new widget. This is one of 05-EXECUTION-PLAN §3's append-only
 * registration points, the way `05-EXECUTION-PLAN.md` itself describes `WIDGET_REGISTRY`:
 * Wave 3 feature agents add their own richer widget here later, one line each.
 *
 * 21 keys came from the task file's own enumeration; a 22nd, `list_tenants_without_ceiling`,
 * is in the actual seed migration (`T004_003`, `country_admin` role) but missing from that
 * list — the seed migration is the more concrete, more recent artifact of the two, so it wins
 * (AGENT-PROTOCOL §3) and is included here too, flagged in the completion report.
 *
 * **T-092 (2026-08-24):** all 22 keys below now resolve to real data — `back-end/src/modules/
 * dashboard` (that task's own fix) added the `GET /dashboard/widgets/:widgetKey` route
 * `./widgets/api.ts` has called since this file was written, and enumerates the same 22 keys
 * independently (`dashboard.constants.ts#WIDGET_KEY`) so a typo on either side is a compile
 * error, not a silently-blank tile. Nothing in this file's mapping changed.
 */
import type { ComponentType } from 'react';
import {
  Activity,
  Building2,
  CheckCircle2,
  ClipboardList,
  FileWarning,
  Globe2,
  ListChecks,
  ShoppingBag,
  Users,
} from 'lucide-react';
import { createChartWidget } from './widgets/ChartWidget';
import { createKpiWidget } from './widgets/KpiWidget';
import { createListWidget } from './widgets/ListWidget';
import type { WidgetProps } from './widgets/types';

export const WIDGET_REGISTRY: Record<string, ComponentType<WidgetProps>> = {
  // --- KPI tiles ---------------------------------------------------------------------------
  kpi_countries: createKpiWidget('kpi_countries', { icon: Globe2 }),
  kpi_tenants: createKpiWidget('kpi_tenants', { icon: Building2 }),
  kpi_active_campaigns: createKpiWidget('kpi_active_campaigns', { icon: Activity }),
  kpi_pending_approvals: createKpiWidget('kpi_pending_approvals', { icon: ClipboardList }),
  kpi_users: createKpiWidget('kpi_users', { icon: Users }),
  kpi_merchants: createKpiWidget('kpi_merchants', { icon: ShoppingBag }),
  kpi_campaigns_by_status: createKpiWidget('kpi_campaigns_by_status', { icon: ListChecks }),
  kpi_my_drafts: createKpiWidget('kpi_my_drafts', { icon: ClipboardList }),
  kpi_my_pending: createKpiWidget('kpi_my_pending', { icon: ClipboardList }),
  kpi_my_rejected: createKpiWidget('kpi_my_rejected', { icon: FileWarning }),
  kpi_pending_my_review: createKpiWidget('kpi_pending_my_review', { icon: ClipboardList }),
  kpi_approved_today: createKpiWidget('kpi_approved_today', { icon: CheckCircle2 }),
  kpi_my_activities: createKpiWidget('kpi_my_activities', { icon: Activity }),

  // --- Charts --------------------------------------------------------------------------------
  chart_campaigns_by_country: createChartWidget('chart_campaigns_by_country'),
  chart_campaign_performance: createChartWidget('chart_campaign_performance'),

  // --- Lists ---------------------------------------------------------------------------------
  list_recent_admin_activity: createListWidget('list_recent_admin_activity', {
    emptyMessage: 'No recent admin activity',
  }),
  list_recent_tenants: createListWidget('list_recent_tenants', {
    emptyMessage: 'No tenants onboarded yet',
  }),
  // Present in the seed migration, absent from the task file's own list — see file banner.
  list_tenants_without_ceiling: createListWidget('list_tenants_without_ceiling', {
    emptyMessage: 'Every tenant has a budget ceiling',
  }),
  list_pending_approvals: createListWidget('list_pending_approvals', {
    emptyMessage: 'Nothing waiting for approval',
  }),
  list_my_campaigns: createListWidget('list_my_campaigns', { emptyMessage: 'No campaigns yet' }),
  list_returned_for_rework: createListWidget('list_returned_for_rework', {
    emptyMessage: 'Nothing returned for rework',
  }),
  list_approval_queue: createListWidget('list_approval_queue', {
    emptyMessage: 'The approval queue is empty',
  }),
};
