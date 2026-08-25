import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Seeds `reward_config.role_dashboard_widgets` — default dashboards per role, verbatim from
 * 01-DATABASE.md §5.3 (gap G7). Each combined "KPI tiles" cell in the doc's table is one
 * shorthand for several individual widgets (one per `kpi_*` key, each carrying its own
 * `sort_order`) — expanded here into one row per widget, matching the per-key sort orders
 * the doc gives.
 *
 * `widget_config` is a small JSON hint of the widget's rendering shape (`kpi` / `chart` /
 * `list`); the doc does not specify its content, so this is a reasonable, non-breaking
 * default the front-end (T-023) is free to extend — not a value under test.
 *
 * Idempotent via `ON CONFLICT (role, widget_key) DO NOTHING`
 * (`uq_role_dashboard_widgets_role_key UNIQUE (role, widget_key)`, confirmed live).
 */

interface WidgetRow {
  role: string;
  widgetKey: string;
  label: string;
  type: 'kpi' | 'chart' | 'list';
  sortOrder: number;
}

// Verbatim transcription of 01-DATABASE.md §5.3, combined cells expanded per-widget.
export const ROLE_DASHBOARD_WIDGETS: WidgetRow[] = [
  // super_admin
  {
    role: 'super_admin',
    widgetKey: 'kpi_countries',
    label: 'Countries',
    type: 'kpi',
    sortOrder: 10,
  },
  { role: 'super_admin', widgetKey: 'kpi_tenants', label: 'Tenants', type: 'kpi', sortOrder: 20 },
  {
    role: 'super_admin',
    widgetKey: 'kpi_active_campaigns',
    label: 'Active Campaigns',
    type: 'kpi',
    sortOrder: 30,
  },
  {
    role: 'super_admin',
    widgetKey: 'chart_campaigns_by_country',
    label: 'Campaigns by Country',
    type: 'chart',
    sortOrder: 40,
  },
  {
    role: 'super_admin',
    widgetKey: 'list_recent_admin_activity',
    label: 'Recent Admin Activity',
    type: 'list',
    sortOrder: 50,
  },

  // country_admin
  { role: 'country_admin', widgetKey: 'kpi_tenants', label: 'Tenants', type: 'kpi', sortOrder: 10 },
  {
    role: 'country_admin',
    widgetKey: 'kpi_active_campaigns',
    label: 'Active Campaigns',
    type: 'kpi',
    sortOrder: 20,
  },
  {
    role: 'country_admin',
    widgetKey: 'kpi_pending_approvals',
    label: 'Pending Approvals',
    type: 'kpi',
    sortOrder: 30,
  },
  {
    role: 'country_admin',
    widgetKey: 'list_recent_tenants',
    label: 'Recently Onboarded Tenants',
    type: 'list',
    sortOrder: 40,
  },
  {
    role: 'country_admin',
    widgetKey: 'list_tenants_without_ceiling',
    label: 'Tenants Without a Budget Ceiling',
    type: 'list',
    sortOrder: 50,
  },

  // tenant_admin
  { role: 'tenant_admin', widgetKey: 'kpi_users', label: 'Users', type: 'kpi', sortOrder: 10 },
  {
    role: 'tenant_admin',
    widgetKey: 'kpi_merchants',
    label: 'Merchants',
    type: 'kpi',
    sortOrder: 20,
  },
  {
    role: 'tenant_admin',
    widgetKey: 'kpi_campaigns_by_status',
    label: 'Campaigns by Status',
    type: 'kpi',
    sortOrder: 30,
  },
  {
    role: 'tenant_admin',
    widgetKey: 'list_pending_approvals',
    label: 'Pending Approvals',
    type: 'list',
    sortOrder: 40,
  },

  // maker
  { role: 'maker', widgetKey: 'kpi_my_drafts', label: 'My Drafts', type: 'kpi', sortOrder: 10 },
  { role: 'maker', widgetKey: 'kpi_my_pending', label: 'My Pending', type: 'kpi', sortOrder: 20 },
  { role: 'maker', widgetKey: 'kpi_my_rejected', label: 'My Rejected', type: 'kpi', sortOrder: 30 },
  {
    role: 'maker',
    widgetKey: 'list_my_campaigns',
    label: 'My Campaigns',
    type: 'list',
    sortOrder: 40,
  },
  {
    role: 'maker',
    widgetKey: 'list_returned_for_rework',
    label: 'Returned for Rework',
    type: 'list',
    sortOrder: 50,
  },

  // checker
  {
    role: 'checker',
    widgetKey: 'kpi_pending_my_review',
    label: 'Pending My Review',
    type: 'kpi',
    sortOrder: 10,
  },
  {
    role: 'checker',
    widgetKey: 'kpi_approved_today',
    label: 'Approved Today',
    type: 'kpi',
    sortOrder: 20,
  },
  {
    role: 'checker',
    widgetKey: 'list_approval_queue',
    label: 'Approval Queue',
    type: 'list',
    sortOrder: 30,
  },

  // merchant
  {
    role: 'merchant',
    widgetKey: 'kpi_active_campaigns',
    label: 'Active Campaigns',
    type: 'kpi',
    sortOrder: 10,
  },
  {
    role: 'merchant',
    widgetKey: 'kpi_my_activities',
    label: 'My Activities',
    type: 'kpi',
    sortOrder: 20,
  },
  {
    role: 'merchant',
    widgetKey: 'chart_campaign_performance',
    label: 'Campaign Performance',
    type: 'chart',
    sortOrder: 30,
  },
  {
    role: 'merchant',
    widgetKey: 'list_my_campaigns',
    label: 'Participating Campaigns',
    type: 'list',
    sortOrder: 40,
  },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of ROLE_DASHBOARD_WIDGETS) {
      await context.query(
        `INSERT INTO reward_config.role_dashboard_widgets
             (role, widget_key, label, widget_config, sort_order)
         VALUES (:role, :widgetKey, :label, :widgetConfig, :sortOrder)
         ON CONFLICT (role, widget_key) DO NOTHING;`,
        {
          type: QueryTypes.INSERT,
          transaction: t,
          replacements: {
            role: row.role,
            widgetKey: row.widgetKey,
            label: row.label,
            widgetConfig: JSON.stringify({ type: row.type }),
            sortOrder: row.sortOrder,
          },
        },
      );
    }
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** Deletes exactly the rows this migration inserted, matched by the natural key
 * (role, widget_key) — any widget Super Admin added afterwards is untouched. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of ROLE_DASHBOARD_WIDGETS) {
      await context.query(
        `DELETE FROM reward_config.role_dashboard_widgets
             WHERE role = :role AND widget_key = :widgetKey;`,
        {
          type: QueryTypes.RAW,
          transaction: t,
          replacements: { role: row.role, widgetKey: row.widgetKey },
        },
      );
    }
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
