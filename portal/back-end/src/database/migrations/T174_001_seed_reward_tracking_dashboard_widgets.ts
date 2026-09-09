import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-INT-031 (`reward-service-integration-plan`) — seeds `reward_config.role_dashboard_widgets`
 * with this task's two new keys (`kpi_reward_tracking_alerts`/`list_campaign_reward_progress`,
 * `widgetRegistry.ts`'s own header), for all six portal roles.
 *
 * **Filename deviation, disclosed** (same call T-INT-030's own completion report made for
 * `T172_001`): the task file's own "Files owned" list names this
 * `T173_seed_reward_tracking_dashboard_widgets.ts`, but `T173_001`/`T173_002` are already real,
 * unrelated migrations (`reward_expiry_duration`, `extend_reward_version_immutability`) — listing
 * the actual directory (implementation note 1's own instruction: "confirm the next free migration
 * number/prefix convention by listing `portal/back-end/src/database/migrations/` directly") shows
 * `T174` is the next free task-number prefix, and every migration in this codebase follows
 * `T<task>_<seq>_<description>.ts` — never a bare `T<task>_<description>.ts` with no seq segment.
 * Used `T174_001_...` to match both facts.
 *
 * **All six roles, matching this task's own scope statement** ("role-visible per
 * super_admin/country_admin/tenant_admin/maker/checker/merchant") and RTS's own guard
 * (`admin-rewards.controller.ts`'s `ALL_PORTAL_ROLES` — every one of the six can call the `alerts`
 * endpoint these two widgets source from, correctly scoped by RTS itself; see
 * `RewardTrackingSummaryWidget.tsx`'s own header for why `alerts` specifically, over the four
 * other `summary` endpoints, is the one this task's widgets call).
 *
 * `sort_order` picks up immediately after each role's own highest existing value in
 * `T004_003_seed_role_dashboard_widgets.ts` (confirmed by reading that file directly), so the two
 * new tiles land after a role's pre-existing dashboard, never reordering anything already seeded.
 *
 * Idempotent via the same `ON CONFLICT (role, widget_key) DO NOTHING` `T004_003` itself uses
 * (`uq_role_dashboard_widgets_role_key`).
 */

interface WidgetRow {
  role: string;
  widgetKey: string;
  label: string;
  type: 'kpi' | 'list';
  sortOrder: number;
}

const KPI_LABEL = 'Reward Budget Alerts';
const LIST_LABEL = 'Campaign Reward Progress';

// Next free sort_order per role, one past T004_003's own highest value for that role.
const NEXT_SORT_ORDER: Record<string, number> = {
  super_admin: 60,
  country_admin: 60,
  tenant_admin: 50,
  maker: 60,
  checker: 40,
  merchant: 50,
};

export const REWARD_TRACKING_DASHBOARD_WIDGETS: WidgetRow[] = Object.entries(
  NEXT_SORT_ORDER,
).flatMap(([role, nextOrder]) => [
  {
    role,
    widgetKey: 'kpi_reward_tracking_alerts',
    label: KPI_LABEL,
    type: 'kpi' as const,
    sortOrder: nextOrder,
  },
  {
    role,
    widgetKey: 'list_campaign_reward_progress',
    label: LIST_LABEL,
    type: 'list' as const,
    sortOrder: nextOrder + 10,
  },
]);

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of REWARD_TRACKING_DASHBOARD_WIDGETS) {
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
 * (role, widget_key) — same shape as `T004_003`'s own `down()`. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of REWARD_TRACKING_DASHBOARD_WIDGETS) {
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
