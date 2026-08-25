import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Least-privilege grants — verbatim from 01-DATABASE.md §3. This is a **hard control**:
 * even a SQL-injection or ORM bug in the app cannot drop a `reward_config` table, because
 * the role the app connects as (`reward_app`) is never granted that privilege at the
 * database level. `DELETE` is granted nowhere — the portal soft-deletes everywhere.
 *
 * Must run as a privileged role (this migration runner's own connection —
 * migration-connection.ts, DB_MIGRATION_*). If the connected role cannot grant, this fails
 * loudly (a real Postgres permission error), never silently skips (T-002 note 6).
 */
const APP_ROLE = 'reward_app';

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(`GRANT USAGE, CREATE ON SCHEMA reward_portal TO ${APP_ROLE};`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await context.query(`GRANT ALL ON ALL TABLES IN SCHEMA reward_portal TO ${APP_ROLE};`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await context.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA reward_portal TO ${APP_ROLE};`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    // Future tables created in reward_portal (T-005/006/007/047/055's own migrations,
    // running as this same privileged role) inherit these grants automatically.
    await context.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA reward_portal GRANT ALL ON TABLES TO ${APP_ROLE};`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA reward_portal GRANT ALL ON SEQUENCES TO ${APP_ROLE};`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(`GRANT USAGE ON SCHEMA reward_config TO ${APP_ROLE};`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await context.query(
      `GRANT SELECT ON reward_config.rule_categories, reward_config.rule_sub_categories,
              reward_config.activity_categories, reward_config.activity_types
          TO ${APP_ROLE};`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `GRANT SELECT, INSERT, UPDATE ON
              reward_config.countries, reward_config.tenants, reward_config.merchants,
              reward_config.merchant_stores, reward_config.merchant_activities,
              reward_config.role_nav_configs, reward_config.role_entity_permissions,
              reward_config.role_dashboard_widgets, reward_config.rbac_cache_config,
              reward_config.system_messages,
              reward_config.rule_master, reward_config.rule_country_assignments,
              reward_config.reward_systems, reward_config.reward_policies,
              reward_config.reward_country_assignments,
              reward_config.tenant_campaigns, reward_config.campaign_merchants,
              reward_config.tenant_campaign_trackers, reward_config.trackers,
              reward_config.approval_policies, reward_config.approval_requests,
              reward_config.entity_assignments, reward_config.user_notifications
          TO ${APP_ROLE};`,
      { type: QueryTypes.RAW, transaction: t },
    );
    // T-091: 9 further reward_config tables that existed in the schema since before this
    // migration first ran, but were never part of the hand-copied list above — an omission
    // in the original "verbatim from 01-DATABASE.md §3" copy (that doc's own §3 never
    // enumerated them either, see the T-091 completion report). Same read/write privilege
    // level as the structurally identical tables already listed above (entity_assignments,
    // campaign_merchants, merchant_activities): plain tenant-scoped catalogue/assignment
    // tables the portal both reads and writes, none of them append-only audit tables.
    // Tables created by later migrations (T005/T006/T007/T042) cannot be granted here —
    // they don't exist yet at this point in the chain — see T007_002 (grants its own new
    // table at creation time) and T091_001 (grants the rest, added after they all exist).
    //
    // No explicit `REVOKE DELETE` here, deliberately, even though `01-DATABASE.md §3` states
    // "DELETE is granted nowhere": this schema (unlike `reward_portal`) is the pre-existing,
    // real `reward_config` database (CLAUDE.md), and it already carries its own
    // `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA reward_config GRANT ... TO
    // reward_app` from before this project touched it, confirmed live via `pg_default_acl` —
    // every table the migration role creates here inherits `reward_app`
    // INSERT/SELECT/UPDATE/DELETE automatically. `T006_001_campaign_caps.ts`'s own test
    // (`campaign-caps.e2e-spec.ts`, "reward_app can write campaign_caps (pre-existing
    // reward_config default ACL, verified live)") already investigated exactly this and
    // pinned it as an accepted, relied-upon fact for `campaign_caps`/`tenant_budget_ceilings`
    // — its own `afterAll` cleanup uses `reward_app`'s `DELETE` directly. Explicitly
    // revoking `DELETE` here for this task's 9 tables only would be an inconsistent,
    // table-by-table policy no design doc asks for and would contradict that established,
    // already-reviewed precedent. This is flagged as a genuine, pre-existing conflict
    // between `01-DATABASE.md §3`'s stated policy and this real database's actual, inherited
    // ACL in the T-091 completion report, for the architect to resolve — not silently picked
    // one way or the other by this migration.
    await context.query(
      `GRANT SELECT, INSERT, UPDATE ON
              reward_config.activities, reward_config.tracker_components,
              reward_config.tracker_tracker_components,
              reward_config.tracker_component_rules, reward_config.tracker_component_groups,
              reward_config.reward_assignment_cap_overrides,
              reward_config.reward_campaign_assignments,
              reward_config.reward_component_assignments,
              reward_config.reward_tracker_assignments
          TO ${APP_ROLE};`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // Audit is append-only. No UPDATE, no DELETE, by anyone, ever.
    await context.query(
      `GRANT SELECT, INSERT ON reward_config.campaign_audit_trail TO ${APP_ROLE};`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(`GRANT SELECT, INSERT ON reward_portal.portal_audit_log TO ${APP_ROLE};`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await context.query(
      `REVOKE UPDATE, DELETE ON reward_config.campaign_audit_trail FROM ${APP_ROLE};`,
      { type: QueryTypes.RAW, transaction: t },
    );
    // TRUNCATE is a distinct Postgres privilege, not implied by DELETE — the blanket
    // `GRANT ALL ON ALL TABLES IN SCHEMA reward_portal` above (needed for reward_app's
    // ordinary read/write tables) hands it to this table too unless revoked explicitly
    // here, the same way T037_002/T040_001's sibling audit tables revoke it at creation
    // time instead of inheriting the blanket grant. Without this, `reward_app` — i.e. a
    // compromised application, not a legitimate caller — can irreversibly empty the audit
    // trail and reset its identity sequence with a single statement, defeating the
    // append-only control 01-DATABASE.md §3 exists to provide. (T-080, found by T-051 TC-24.)
    await context.query(
      `REVOKE UPDATE, DELETE, TRUNCATE ON reward_portal.portal_audit_log FROM ${APP_ROLE};`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * Revokes everything this migration granted. Does not revoke USAGE on reward_portal or
 * reward_config outright (harmless to leave, and other migrations' own down() calls may
 * still need the app role's read access mid-rollback) — instead removes the specific
 * elevated grants, which is what a real rollback of "grant these privileges" means.
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`REVOKE ALL ON ALL TABLES IN SCHEMA reward_portal FROM ${APP_ROLE};`, {
    type: QueryTypes.RAW,
  });
  await context.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA reward_portal FROM ${APP_ROLE};`, {
    type: QueryTypes.RAW,
  });
  await context.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA reward_portal REVOKE ALL ON TABLES FROM ${APP_ROLE};`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA reward_portal REVOKE ALL ON SEQUENCES FROM ${APP_ROLE};`,
    { type: QueryTypes.RAW },
  );
  await context.query(`REVOKE CREATE, USAGE ON SCHEMA reward_portal FROM ${APP_ROLE};`, {
    type: QueryTypes.RAW,
  });

  await context.query(
    `REVOKE SELECT, INSERT, UPDATE ON
        reward_config.countries, reward_config.tenants, reward_config.merchants,
        reward_config.merchant_stores, reward_config.merchant_activities,
        reward_config.role_nav_configs, reward_config.role_entity_permissions,
        reward_config.role_dashboard_widgets, reward_config.rbac_cache_config,
        reward_config.system_messages,
        reward_config.rule_master, reward_config.rule_country_assignments,
        reward_config.reward_systems, reward_config.reward_policies,
        reward_config.reward_country_assignments,
        reward_config.tenant_campaigns, reward_config.campaign_merchants,
        reward_config.tenant_campaign_trackers, reward_config.trackers,
        reward_config.approval_policies, reward_config.approval_requests,
        reward_config.entity_assignments, reward_config.user_notifications
    FROM ${APP_ROLE};`,
    { type: QueryTypes.RAW },
  );
  // T-091: mirrors the additional GRANT added to up() above.
  await context.query(
    `REVOKE SELECT, INSERT, UPDATE ON
        reward_config.activities, reward_config.tracker_components,
        reward_config.tracker_tracker_components,
        reward_config.tracker_component_rules, reward_config.tracker_component_groups,
        reward_config.reward_assignment_cap_overrides,
        reward_config.reward_campaign_assignments,
        reward_config.reward_component_assignments,
        reward_config.reward_tracker_assignments
    FROM ${APP_ROLE};`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `REVOKE SELECT ON reward_config.rule_categories, reward_config.rule_sub_categories,
        reward_config.activity_categories, reward_config.activity_types
    FROM ${APP_ROLE};`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `REVOKE SELECT, INSERT ON reward_config.campaign_audit_trail FROM ${APP_ROLE};`,
    {
      type: QueryTypes.RAW,
    },
  );
  await context.query(`REVOKE USAGE ON SCHEMA reward_config FROM ${APP_ROLE};`, {
    type: QueryTypes.RAW,
  });
}
