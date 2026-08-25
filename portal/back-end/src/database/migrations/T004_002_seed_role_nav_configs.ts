import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Seeds `reward_config.role_nav_configs` — default menus per role, verbatim from
 * 01-DATABASE.md §5.2 (gap G7). Drives T-023's dynamic nav; Super Admin may reorder or
 * disable any row afterwards through the UI (`enabled`, `sort_order`) — this seed only
 * establishes the starting state.
 *
 * Idempotent via `ON CONFLICT (role, nav_key) DO NOTHING`
 * (`uq_role_nav_configs_role_key UNIQUE (role, nav_key)`, confirmed live).
 */

interface NavRow {
  role: string;
  navKey: string;
  label: string;
  path: string;
  sortOrder: number;
}

// Verbatim transcription of 01-DATABASE.md §5.2.
export const ROLE_NAV_CONFIGS: NavRow[] = [
  // super_admin
  {
    role: 'super_admin',
    navKey: 'dashboard',
    label: 'Dashboard',
    path: '/dashboard',
    sortOrder: 10,
  },
  {
    role: 'super_admin',
    navKey: 'countries',
    label: 'Countries',
    path: '/countries',
    sortOrder: 20,
  },
  { role: 'super_admin', navKey: 'rules', label: 'Rules', path: '/rules', sortOrder: 30 },
  { role: 'super_admin', navKey: 'rewards', label: 'Rewards', path: '/rewards', sortOrder: 40 },
  { role: 'super_admin', navKey: 'users', label: 'Users', path: '/users', sortOrder: 50 },
  {
    role: 'super_admin',
    navKey: 'access_control',
    label: 'Access Control',
    path: '/admin/access-control',
    sortOrder: 60,
  },
  {
    role: 'super_admin',
    navKey: 'grpc_grants',
    label: 'Service Grants',
    path: '/admin/grpc-grants',
    sortOrder: 65,
  },
  { role: 'super_admin', navKey: 'audit', label: 'Audit Log', path: '/audit', sortOrder: 70 },

  // country_admin
  {
    role: 'country_admin',
    navKey: 'dashboard',
    label: 'Dashboard',
    path: '/dashboard',
    sortOrder: 10,
  },
  { role: 'country_admin', navKey: 'tenants', label: 'Tenants', path: '/tenants', sortOrder: 20 },
  { role: 'country_admin', navKey: 'users', label: 'Tenant Admins', path: '/users', sortOrder: 30 },
  {
    role: 'country_admin',
    navKey: 'budget_ceilings',
    label: 'Budget Ceilings',
    path: '/tenants/ceilings',
    sortOrder: 35,
  },
  {
    role: 'country_admin',
    navKey: 'rules',
    label: 'Assigned Rules',
    path: '/rules',
    sortOrder: 40,
  },
  {
    role: 'country_admin',
    navKey: 'rewards',
    label: 'Assigned Rewards',
    path: '/rewards',
    sortOrder: 50,
  },

  // tenant_admin
  {
    role: 'tenant_admin',
    navKey: 'dashboard',
    label: 'Dashboard',
    path: '/dashboard',
    sortOrder: 10,
  },
  { role: 'tenant_admin', navKey: 'users', label: 'Users', path: '/users', sortOrder: 20 },
  {
    role: 'tenant_admin',
    navKey: 'merchants',
    label: 'Merchants',
    path: '/merchants',
    sortOrder: 30,
  },
  {
    role: 'tenant_admin',
    navKey: 'campaigns',
    label: 'Campaigns',
    path: '/campaigns',
    sortOrder: 40,
  },

  // maker
  { role: 'maker', navKey: 'dashboard', label: 'Dashboard', path: '/dashboard', sortOrder: 10 },
  { role: 'maker', navKey: 'campaigns', label: 'My Campaigns', path: '/campaigns', sortOrder: 20 },
  {
    role: 'maker',
    navKey: 'campaign_new',
    label: 'Create Campaign',
    path: '/campaigns/new',
    sortOrder: 30,
  },

  // checker
  { role: 'checker', navKey: 'dashboard', label: 'Dashboard', path: '/dashboard', sortOrder: 10 },
  {
    role: 'checker',
    navKey: 'approvals',
    label: 'Approval Queue',
    path: '/approvals',
    sortOrder: 20,
  },
  { role: 'checker', navKey: 'campaigns', label: 'Campaigns', path: '/campaigns', sortOrder: 30 },

  // merchant
  { role: 'merchant', navKey: 'dashboard', label: 'Dashboard', path: '/dashboard', sortOrder: 10 },
  {
    role: 'merchant',
    navKey: 'campaigns',
    label: 'My Campaigns',
    path: '/merchant/campaigns',
    sortOrder: 20,
  },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of ROLE_NAV_CONFIGS) {
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

/** Deletes exactly the rows this migration inserted, matched by the natural key
 * (role, nav_key) — any nav row Super Admin added afterwards through the UI is untouched. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of ROLE_NAV_CONFIGS) {
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
