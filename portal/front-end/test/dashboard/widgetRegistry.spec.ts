import { describe, expect, it } from 'vitest';
import { WIDGET_REGISTRY } from '../../src/features/dashboard/widgetRegistry';

/**
 * 01-DATABASE.md §5.3 / the task file's own enumeration, plus `list_tenants_without_ceiling`
 * (present in `T004_003_seed_role_dashboard_widgets.ts`, absent from the task file's list —
 * see `widgetRegistry.ts`'s own banner for why it's included here anyway).
 */
const SEEDED_WIDGET_KEYS = [
  'kpi_countries',
  'kpi_tenants',
  'kpi_active_campaigns',
  'kpi_pending_approvals',
  'kpi_users',
  'kpi_merchants',
  'kpi_campaigns_by_status',
  'kpi_my_drafts',
  'kpi_my_pending',
  'kpi_my_rejected',
  'kpi_pending_my_review',
  'kpi_approved_today',
  'kpi_my_activities',
  'chart_campaigns_by_country',
  'chart_campaign_performance',
  'list_recent_admin_activity',
  'list_recent_tenants',
  'list_tenants_without_ceiling',
  'list_pending_approvals',
  'list_my_campaigns',
  'list_returned_for_rework',
  'list_approval_queue',
];

describe('WIDGET_REGISTRY', () => {
  it('has exactly one entry per seeded widget_key, and nothing extra', () => {
    expect(Object.keys(WIDGET_REGISTRY).sort()).toEqual([...SEEDED_WIDGET_KEYS].sort());
  });

  it.each(SEEDED_WIDGET_KEYS)('%s is a function component', (key) => {
    expect(typeof WIDGET_REGISTRY[key]).toBe('function');
  });

  it('a key not in the seed (e.g. a typo) is genuinely absent — DashboardPage relies on this', () => {
    expect(WIDGET_REGISTRY.definitely_not_a_real_widget).toBeUndefined();
  });
});
