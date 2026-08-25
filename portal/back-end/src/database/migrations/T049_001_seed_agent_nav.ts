import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-049 — seeds `reward_config.role_nav_configs` with the *"Create with AI"* entry
 * (architecture.html §14's own nav row, `/campaigns/assistant`).
 *
 * **Makers only, and no other role.** The screen requires `campaign:create`, which T004_001 grants
 * to `maker` alone; a nav row for anyone else would be a link straight to the Forbidden page. The
 * server enforces the same pair independently (`agent.controller.ts` — `@Roles('maker')` plus
 * `@RequirePermission('campaign','create')`), so this row is a discoverability decision, never an
 * access one.
 *
 * `sortOrder` 35 places it directly after *"Create Campaign"* (30, `T004_002`) and before nothing
 * else the maker has — the wizard stays the first-offered path, which is 10-AI-CAMPAIGN-AGENT.md
 * §9's *"the AI chat is an accelerator, never the only path"* expressed in the menu order.
 *
 * A new, task-id-prefixed migration rather than an edit to `T004_002`, exactly as
 * `T042_002_seed_definition_request_nav.ts` did for the same reason (05-EXECUTION-PLAN §3 — two
 * agents must never edit the same file, and an applied migration must never change under a
 * database that already ran it). Idempotent via `ON CONFLICT (role, nav_key) DO NOTHING`.
 */

interface NavRow {
  role: string;
  navKey: string;
  label: string;
  path: string;
  sortOrder: number;
}

export const AGENT_NAV_CONFIGS: NavRow[] = [
  {
    role: 'maker',
    navKey: 'campaign_assistant',
    label: 'Create with AI',
    path: '/campaigns/assistant',
    sortOrder: 35,
  },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of AGENT_NAV_CONFIGS) {
      await context.query(
        `INSERT INTO reward_config.role_nav_configs (role, nav_key, label, path, sort_order)
         VALUES (:role, :navKey, :label, :path, :sortOrder)
         ON CONFLICT (role, nav_key) DO NOTHING;`,
        {
          type: QueryTypes.INSERT,
          transaction: t,
          replacements: row as unknown as Record<string, unknown>,
        },
      );
    }
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** Deletes exactly the row this migration inserted, matched by the natural key (role, nav_key) —
 * any nav row a Super Admin added afterwards through the Access Control screen is untouched. This
 * is the task's own documented rollback: *"remove the route and its nav entry; the wizard remains
 * the full path."* */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of AGENT_NAV_CONFIGS) {
      await context.query(
        `DELETE FROM reward_config.role_nav_configs WHERE role = :role AND nav_key = :navKey;`,
        {
          type: QueryTypes.RAW,
          transaction: t,
          replacements: { role: row.role, navKey: row.navKey },
        },
      );
    }
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
