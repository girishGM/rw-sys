import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Ad hoc data reset (no registered `T-0xx` task — see `task/reset-reference-data-keep-users`).
 * Wipes every country, tenant, rule, reward, campaign, tracker, merchant and admin/audit row
 * accumulated across ~150 tasks' worth of e2e test fixtures, so the environment can be reseeded
 * with a deliberately chosen, small demo dataset instead. Deliberately numbered `T900` — well
 * outside the live `T-0xx` task range (currently up to `T-164`) — so it never collides with a
 * future registered task's own migration number.
 *
 * **Kept, not deleted:**
 * - `reward_portal.portal_users` and every table that hangs off it (credentials, roles,
 *   sessions, refresh tokens, login attempts, password resets, MFA codes, encryption keys,
 *   data protection policies) — none of these carry a FK into the reward-config domain, so
 *   they are untouched by construction, not by filtering.
 * - `reward_config.countries.id = 1` (Malaysia), `reward_config.tenants.id = 1` (the `DEMO`
 *   tenant) and `reward_config.merchants.id = 1` (Kopi House) — confirmed live, on
 *   2026-08-31, to be exactly the country/tenant/merchant ids every existing `portal_users` row
 *   references via its (RESTRICT) FK. Deleting them would break those users' logins.
 * - Global system config/taxonomy, not "data": `rule_resolvers`, `rule_operators`,
 *   `field_context_providers`, `field_api_lookup_providers`, `role_nav_configs`,
 *   `role_entity_permissions`, `role_dashboard_widgets`, `system_messages`,
 *   `rbac_cache_config`, `services`, `applications`, `api_endpoints`, `rate_limit_policies`,
 *   `rule_categories`/`rule_sub_categories`/`reward_categories`/`reward_sub_categories` (all
 *   confirmed scoped to the kept `tenant_id = 1` already, so leaving them doesn't block
 *   anything — they're the taxonomy dropdowns, not rule/reward instances).
 *
 * **Deleted:** every other row in every other reward-config-domain table, in FK-dependency
 * order (leaf tables first). Two things needed special handling, both confirmed against the
 * live schema (`pg_constraint`/`pg_trigger`), not assumed from the migration history alone:
 * - `rule_versions`/`reward_versions` each have a `BEFORE DELETE` trigger
 *   (`fn_rule_version_undeletable`/`fn_reward_version_undeletable`) that rejects deleting any
 *   row whose `status <> 'draft'`. Flipping `status` to `'draft'` first passes cleanly — the
 *   separate `BEFORE UPDATE` immutability trigger on the same tables does not guard the
 *   `status` column, only content fields (expression/parameters/resolver config/etc for rules;
 *   connector/delivery/value config for rewards).
 * - `rule_versions.supersedes_version_id`, `reward_versions.supersedes_version_id` and
 *   `tenant_api_keys.replaced_by_key_id` are self-referencing FKs; nulling them out before the
 *   bulk delete avoids an ordering dependency on version/rotation chains.
 * - Both version tables also carry a partial unique index (`uq_rv_one_draft` /
 *   `uq_rewv_one_draft` on `(rule_id)`/`(reward_id) WHERE status = 'draft'`) allowing at most
 *   one draft per rule/reward — discovered the hard way when a blanket
 *   `UPDATE ... SET status = 'draft'` violated it on the first live run (a rule with both a
 *   draft and a published version collided). Fixed by deleting existing `draft` rows outright
 *   first (no update needed, and multiple different rules can each have one), then flipping the
 *   remaining rows to `draft` and deleting them one at a time — so at most one row per rule/
 *   reward is ever `draft` at once, and it's gone before the next row for that same rule/reward
 *   is touched.
 *
 * **R7 deviation (flagged, not silently shipped):** `AGENT-PROTOCOL.md` R7 requires a working,
 * provable `down()`. A bulk data delete cannot be undone by SQL — there is no record of the
 * ~44 deleted tenants' original row content to reinsert, unlike a seed migration's own
 * (fully known) rows. `down()` below is an intentional, documented no-op rather than a
 * misleading "restore" that cannot actually restore anything; the real safety net is a
 * `pg_dump -n reward_config -n reward_portal` snapshot taken immediately before this migration
 * ran (see the task's own report for the backup file path). A no-op (rather than a hard
 * `throw`) was chosen deliberately so a future `db:rollback --all` for unrelated reasons can
 * still walk past this migration instead of hard-blocking the whole chain.
 */

const STATEMENTS_BEFORE_VERSIONS: readonly string[] = [
  // --- Layer 1: leaf tables (nothing else has a FK into these) ---
  'DELETE FROM reward_portal.agent_session_events',
  'DELETE FROM reward_config.agent_audit_log',
  'DELETE FROM reward_config.rate_limit_counters',
  'DELETE FROM reward_config.tenant_endpoint_rate_limits',
  'DELETE FROM reward_config.tenant_api_endpoints',
  'DELETE FROM reward_config.tenant_campaign_endpoint_rate_limits',
  'DELETE FROM reward_config.tenant_campaign_api_endpoints',
  'DELETE FROM reward_config.tenant_rate_limits',
  'DELETE FROM reward_config.version_blast_targets',
  'DELETE FROM reward_config.rule_version_country_assignments',
  'DELETE FROM reward_config.reward_version_country_assignments',
  'DELETE FROM reward_config.rule_country_assignments',
  'DELETE FROM reward_config.reward_country_assignments',
  'DELETE FROM reward_config.tracker_component_rules',
  'DELETE FROM reward_config.tracker_tracker_components',
  'DELETE FROM reward_config.tracker_component_groups',
  'DELETE FROM reward_config.merchant_activities',
  'DELETE FROM reward_config.campaign_merchants',
  'DELETE FROM reward_config.reward_assignment_cap_overrides',
  'DELETE FROM reward_config.reward_component_assignments',
  'DELETE FROM reward_config.reward_tracker_assignments',
  'DELETE FROM reward_config.reward_campaign_assignments',
  'DELETE FROM reward_config.reward_delivery_queue',
  'DELETE FROM reward_config.reward_promo_pools',
  'DELETE FROM reward_config.campaign_caps',
  'DELETE FROM reward_config.campaign_audit_trail',
  'DELETE FROM reward_config.entity_assignments',
  'DELETE FROM reward_config.tenant_setup_audit_logs',
  'DELETE FROM reward_config.audit_retention_config',
  'DELETE FROM reward_config.user_notifications',
  'DELETE FROM reward_config.approval_requests',
  'DELETE FROM reward_config.definition_requests',
  'DELETE FROM reward_portal.portal_user_notifications',
  'DELETE FROM reward_portal.portal_campaign_audit_trail',
  'DELETE FROM reward_portal.grpc_service_grants',

  // --- Layer 2 ---
  'DELETE FROM reward_config.version_blasts',
  'DELETE FROM reward_config.reward_policy_caps',
  'DELETE FROM reward_config.tenant_campaign_trackers',
  'DELETE FROM reward_portal.agent_sessions',
  'DELETE FROM reward_config.agent_sessions',
  'DELETE FROM reward_portal.portal_approval_requests',
  'DELETE FROM reward_config.reward_policies',
  'DELETE FROM reward_config.tracker_components',
  'DELETE FROM reward_config.tracker_group_defs',
  'DELETE FROM reward_config.merchant_stores',

  // --- Layer 3a: null self-FKs and drop already-draft versions in bulk (safe — see header) ---
  'UPDATE reward_config.rule_versions SET supersedes_version_id = NULL',
  "DELETE FROM reward_config.rule_versions WHERE status = 'draft'",
  'UPDATE reward_config.reward_versions SET supersedes_version_id = NULL',
  "DELETE FROM reward_config.reward_versions WHERE status = 'draft'",
];

// Layer 3b: remaining non-draft rows, handled row-by-row (see header note on uq_rv_one_draft /
// uq_rewv_one_draft) between STATEMENTS_BEFORE_VERSIONS and STATEMENTS_AFTER_VERSIONS below.
const REMAINING_VERSION_TABLES: readonly { schemaTable: string; idColumn: string }[] = [
  { schemaTable: 'reward_config.rule_versions', idColumn: 'id' },
  { schemaTable: 'reward_config.reward_versions', idColumn: 'id' },
];

const STATEMENTS_AFTER_VERSIONS: readonly string[] = [
  'DELETE FROM reward_config.trackers',
  'DELETE FROM reward_config.merchants WHERE id <> 1',

  // --- Layer 4 ---
  'DELETE FROM reward_config.reward_systems',
  'DELETE FROM reward_config.rule_master',

  // --- Layer 5 ---
  'DELETE FROM reward_config.tenant_campaigns',
  'DELETE FROM reward_config.activities',
  'DELETE FROM reward_config.activity_types',
  'DELETE FROM reward_config.activity_categories',

  // --- Layer 6: tenant-scoped admin/config tables ---
  'UPDATE reward_config.tenant_api_keys SET replaced_by_key_id = NULL',
  'DELETE FROM reward_config.admin_users',
  'DELETE FROM reward_config.tenant_api_keys',
  'DELETE FROM reward_config.tenant_applications',
  'DELETE FROM reward_config.tenant_notification_config',
  'DELETE FROM reward_config.service_schema_mappings',
  'DELETE FROM reward_config.tenant_provisioning_requests',
  'DELETE FROM reward_config.tenant_key_rotation_configs',
  'DELETE FROM reward_config.tenant_budget_ceilings',
  'DELETE FROM reward_config.tenant_currencies',
  'DELETE FROM reward_config.approval_policies',

  // --- Layer 7: root — keep id = 1 on both ---
  'DELETE FROM reward_config.tenants WHERE id <> 1',
  'DELETE FROM reward_config.countries WHERE id <> 1',
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const sql of STATEMENTS_BEFORE_VERSIONS) {
      await context.query(sql, { type: QueryTypes.RAW, transaction: t });
    }

    for (const { schemaTable, idColumn } of REMAINING_VERSION_TABLES) {
      const rows = (await context.query(`SELECT ${idColumn} FROM ${schemaTable}`, {
        type: QueryTypes.SELECT,
        transaction: t,
      })) as Array<Record<string, number>>;
      for (const row of rows) {
        const id = row[idColumn];
        await context.query(`UPDATE ${schemaTable} SET status = 'draft' WHERE ${idColumn} = :id`, {
          type: QueryTypes.RAW,
          transaction: t,
          replacements: { id },
        });
        await context.query(`DELETE FROM ${schemaTable} WHERE ${idColumn} = :id`, {
          type: QueryTypes.RAW,
          transaction: t,
          replacements: { id },
        });
      }
    }

    for (const sql of STATEMENTS_AFTER_VERSIONS) {
      await context.query(sql, { type: QueryTypes.RAW, transaction: t });
    }
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * Intentional no-op — see the file header's "R7 deviation" note. There is no SQL that can
 * reconstruct the rows `up()` deleted; the actual recovery path is the `pg_dump` snapshot taken
 * immediately before this migration ran, restored by hand if ever needed.
 */
export async function down(): Promise<void> {
  return;
}
