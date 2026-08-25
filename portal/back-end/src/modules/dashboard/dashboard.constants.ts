/**
 * T-092 — the fixed vocabulary `GET /dashboard/widgets/:widgetKey` works from.
 *
 * `WIDGET_KEY` is a transcription of `role_dashboard_widgets`'s seeded rows
 * (`back-end/src/database/migrations/T004_003_seed_role_dashboard_widgets.ts`, `01-DATABASE.md`
 * §5.3) and of the front-end's own `WIDGET_REGISTRY`
 * (`front-end/src/features/dashboard/widgetRegistry.ts`, T-023) — the same 22 keys, listed here
 * so a typo in a resolver's `case` is a compile error rather than a silently-unreachable branch.
 * Kept as a plain object (not imported from either side) because neither the seed migration
 * (`back-end/src/database/migrations/**`) nor the front-end registry is in this task's file
 * scope (R9) — this is this module's own copy, the same "one literal copy per module" precedent
 * `users.constants.ts#USER_ACTIVE_STATUS` already sets for exactly this reason.
 */
export const WIDGET_KEY = Object.freeze({
  KPI_COUNTRIES: 'kpi_countries',
  KPI_TENANTS: 'kpi_tenants',
  KPI_ACTIVE_CAMPAIGNS: 'kpi_active_campaigns',
  KPI_PENDING_APPROVALS: 'kpi_pending_approvals',
  KPI_USERS: 'kpi_users',
  KPI_MERCHANTS: 'kpi_merchants',
  KPI_CAMPAIGNS_BY_STATUS: 'kpi_campaigns_by_status',
  KPI_MY_DRAFTS: 'kpi_my_drafts',
  KPI_MY_PENDING: 'kpi_my_pending',
  KPI_MY_REJECTED: 'kpi_my_rejected',
  KPI_PENDING_MY_REVIEW: 'kpi_pending_my_review',
  KPI_APPROVED_TODAY: 'kpi_approved_today',
  KPI_MY_ACTIVITIES: 'kpi_my_activities',
  CHART_CAMPAIGNS_BY_COUNTRY: 'chart_campaigns_by_country',
  CHART_CAMPAIGN_PERFORMANCE: 'chart_campaign_performance',
  LIST_RECENT_ADMIN_ACTIVITY: 'list_recent_admin_activity',
  LIST_RECENT_TENANTS: 'list_recent_tenants',
  LIST_TENANTS_WITHOUT_CEILING: 'list_tenants_without_ceiling',
  LIST_PENDING_APPROVALS: 'list_pending_approvals',
  LIST_MY_CAMPAIGNS: 'list_my_campaigns',
  LIST_RETURNED_FOR_REWORK: 'list_returned_for_rework',
  LIST_APPROVAL_QUEUE: 'list_approval_queue',
} as const);

export type WidgetKey = (typeof WIDGET_KEY)[keyof typeof WIDGET_KEY];

/**
 * A dashboard tile is a glance, not a report — every `list_*`/`chart_*` resolver below caps
 * itself at this many rows. None of `role_dashboard_widgets`' seeded widgets is paginated
 * (`role_dashboard_widgets` carries no `page_size` column), so the limit lives here rather than
 * on a query parameter the front end never sends.
 */
export const DASHBOARD_LIST_LIMIT = 10;
