/**
 * T-132 — the campaigns e2e suite's "remove what a previous crashed run of **this** suite left
 * behind" step, extracted from `campaigns.e2e-spec.ts` and made genuinely suite-scoped.
 *
 * ### The defect this file exists to fix
 *
 * Every campaign-side step of the original purge was correctly keyed on the suite's own
 * `T037E2E` campaign-code prefix, but its last few statements were not keyed on anything:
 *
 * ```sql
 * DELETE FROM reward_config.trackers WHERE tracker_code LIKE 'TRK-%'
 * ```
 *
 * `TRK-`/`CMP-` are not a suite marker — they are the prefixes `code-generator.ts` puts on
 * **every** tracker and component the portal generates, for every tenant, in every suite and in
 * every manual run. So the statement above tried to delete rows belonging to other people's
 * campaigns, and whenever one of those campaigns still referenced its tracker the delete hit
 * `fk_tct_tracker`, threw inside `beforeAll`, and failed all 84 tests in the file. T-124
 * reproduced exactly that against two stale `QA_SCREENSHOT_*` campaigns left by an unrelated run
 * five days earlier.
 *
 * ### The scoping rule used instead
 *
 * A tracker or component created by this suite is always created **through the API, by an actor
 * whose tenant comes from the verified JWT** — so it always lands in one of the suite's own
 * tenants (`<PREFIX>_TENANT_A` / `_TENANT_B`), which no other suite uses. Tenant membership is
 * therefore the honest boundary, and it is strictly narrower than the campaign link: it still
 * catches residue whose campaign row is already gone, and it can never reach a row another suite
 * owns. The generated-code test is kept on top of it for the same reason `afterAll` keeps it —
 * so a tracker some other task authored by hand inside these tenants is left alone.
 *
 * Every statement below is scoped by `tenants.code LIKE '<prefix>%'`, by
 * `tenant_campaigns.campaign_code LIKE '<prefix>%'`, or by `portal_users.display_name LIKE
 * '<prefix> %'`. Nothing here matches globally. If you add a statement, keep that property — it
 * is the whole point of the file.
 *
 * Runs as the migration role because `reward_portal.portal_campaign_audit_trail` is append-only
 * to `reward_app` by design (T037_002); see the header of `campaigns.e2e-spec.ts`.
 */
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';

export interface SuiteResidueScope {
  /**
   * The suite's fixture prefix — matched against `tenant_campaigns.campaign_code` **and**
   * `tenants.code`. `T037E2E` for the campaigns suite.
   */
  readonly prefix: string;
  /**
   * The `reward_portal.portal_users.display_name` prefix this suite gives its actors, matched as
   * `'<userDisplayNamePrefix> %'`. `'T-037'` for the campaigns suite.
   */
  readonly userDisplayNamePrefix: string;
}

/** Tenants this suite owns. Every tracker/component statement hangs off this set. */
const SUITE_TENANTS = `SELECT id FROM reward_config.tenants WHERE code LIKE :prefixPattern`;

/** Campaigns this suite owns, by code. */
const SUITE_CAMPAIGNS = `SELECT id FROM reward_config.tenant_campaigns
                          WHERE campaign_code LIKE :prefixPattern`;

/** Generated trackers inside this suite's tenants — never a tracker anywhere else. */
const SUITE_TRACKERS = `SELECT id FROM reward_config.trackers
                         WHERE tracker_code LIKE 'TRK-%' AND tenant_id IN (${SUITE_TENANTS})`;

/** Portal actors this suite creates, by display name. */
const SUITE_USERS = `SELECT id FROM reward_portal.portal_users
                      WHERE display_name LIKE :displayNamePattern`;

/** Generated components inside this suite's tenants — never a component anywhere else. */
const SUITE_COMPONENTS = `SELECT id FROM reward_config.tracker_components
                           WHERE component_code LIKE 'CMP-%' AND tenant_id IN (${SUITE_TENANTS})`;

/**
 * Ordered child-first, so nothing is left dangling behind a `RESTRICT` foreign key. The campaign,
 * tracker and component deletes are each preceded by a delete from **every** table that carries a
 * foreign key into them — nine constraints into `tenant_campaigns`, nine into
 * `trackers`/`tracker_components`, read from `pg_constraint` rather than assumed — because a purge
 * that clears eight of nine is a purge that fails the first time the ninth holds a row. That is
 * the whole defect, and the tables it forgot were only ever "empty in practice".
 */
const STATEMENTS: readonly string[] = [
  `DELETE FROM reward_portal.portal_campaign_audit_trail
    WHERE campaign_id IN (${SUITE_CAMPAIGNS})`,

  `DELETE FROM reward_portal.portal_approval_requests
    WHERE entity_type = 'campaign' AND entity_id IN (${SUITE_CAMPAIGNS})`,

  `DELETE FROM reward_config.campaign_caps WHERE campaign_id IN (${SUITE_CAMPAIGNS})`,
  `DELETE FROM reward_config.reward_campaign_assignments
    WHERE campaign_id IN (${SUITE_CAMPAIGNS})`,
  `DELETE FROM reward_config.campaign_merchants WHERE campaign_id IN (${SUITE_CAMPAIGNS})`,

  // The remaining four foreign keys into `tenant_campaigns` (`pg_constraint` lists nine in
  // total). This suite does not write any of them today, but the tracker half of this file is
  // the story of what a single unhandled child row costs — `beforeAll` throws and all 84 tests
  // fail — and a `DELETE … WHERE campaign_id IN (this suite's campaigns)` on a table with no
  // matching rows is free.
  `DELETE FROM reward_config.tenant_campaign_api_endpoints
    WHERE campaign_id IN (${SUITE_CAMPAIGNS})`,
  `DELETE FROM reward_config.tenant_campaign_endpoint_rate_limits
    WHERE campaign_id IN (${SUITE_CAMPAIGNS})`,
  `DELETE FROM reward_config.campaign_audit_trail WHERE campaign_id IN (${SUITE_CAMPAIGNS})`,
  `DELETE FROM reward_portal.agent_sessions WHERE campaign_id IN (${SUITE_CAMPAIGNS})`,

  // Both halves are this suite's own: the campaign link rows of its campaigns, and any link row
  // still pointing at a tracker in its tenants (a crashed run can leave the second without the
  // first once a campaign code was rewritten by hand).
  `DELETE FROM reward_config.tenant_campaign_trackers
    WHERE campaign_id IN (${SUITE_CAMPAIGNS}) OR tracker_id IN (${SUITE_TRACKERS})`,

  `DELETE FROM reward_config.tenant_campaigns WHERE campaign_code LIKE :prefixPattern`,

  `DELETE FROM reward_config.tracker_component_rules
    WHERE tracker_component_id IN (${SUITE_COMPONENTS})`,
  `DELETE FROM reward_config.reward_component_assignments
    WHERE component_id IN (${SUITE_COMPONENTS})`,
  `DELETE FROM reward_config.reward_tracker_assignments
    WHERE tracker_id IN (${SUITE_TRACKERS})`,
  `DELETE FROM reward_config.tracker_component_groups
    WHERE tracker_id IN (${SUITE_TRACKERS}) OR component_id IN (${SUITE_COMPONENTS})`,
  `DELETE FROM reward_config.tracker_group_defs WHERE tracker_id IN (${SUITE_TRACKERS})`,
  `DELETE FROM reward_config.tracker_tracker_components
    WHERE tracker_id IN (${SUITE_TRACKERS}) OR component_id IN (${SUITE_COMPONENTS})`,

  `DELETE FROM reward_config.tracker_components
    WHERE component_code LIKE 'CMP-%' AND tenant_id IN (${SUITE_TENANTS})`,
  `DELETE FROM reward_config.trackers
    WHERE tracker_code LIKE 'TRK-%' AND tenant_id IN (${SUITE_TENANTS})`,

  `DELETE FROM reward_portal.portal_user_notifications
    WHERE user_id IN (${SUITE_USERS})`,
  // Two of `portal_users`' three `ON DELETE RESTRICT` children are keyed on a user rather than on
  // a campaign, so a row in either survives every campaign-scoped statement above and then blocks
  // the user delete. (The third, `portal_campaign_audit_trail`, is campaign-keyed and already
  // gone.) Same reasoning as the campaign block: scoped to this suite's own actors, and free when
  // there is nothing to remove.
  `DELETE FROM reward_portal.agent_sessions WHERE portal_user_id IN (${SUITE_USERS})`,
  `DELETE FROM reward_portal.portal_approval_requests
    WHERE requested_by IN (${SUITE_USERS}) OR reviewed_by IN (${SUITE_USERS})`,
  `DELETE FROM reward_portal.portal_users WHERE display_name LIKE :displayNamePattern`,
];

/**
 * Removes anything a previous, failed run of the suite identified by {@link SuiteResidueScope}
 * left behind. Safe to call when there is no residue, and safe to call while another suite's
 * fixtures — including trackers and components with the same generated `TRK-`/`CMP-` codes —
 * are sitting in the same database.
 */
export async function purgeSuiteResidue(scope: SuiteResidueScope): Promise<void> {
  if (scope.prefix === '' || scope.userDisplayNamePrefix === '') {
    // An empty prefix turns every `LIKE '%'` below into "delete the table". Fail loudly instead.
    throw new Error('purgeSuiteResidue: prefix and userDisplayNamePrefix must be non-empty');
  }
  const replacements = {
    prefixPattern: `${scope.prefix}%`,
    displayNamePattern: `${scope.userDisplayNamePrefix} %`,
  };

  const admin = createMigrationConnection();
  try {
    for (const statement of STATEMENTS) {
      try {
        await admin.query(statement, { type: QueryTypes.RAW, replacements });
      } catch (error) {
        // The migration connection logs nothing, and a Sequelize error surfaced through Jest's
        // `beforeAll` reporter can arrive with an empty `message` — which is how the original
        // defect presented: 84 failed tests, no statement, no constraint name. Naming the
        // statement and the underlying message costs nothing and saves the next diagnosis.
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `purgeSuiteResidue failed on:\n${statement}\n→ ${reason === '' ? String(error) : reason}`,
          { cause: error },
        );
      }
    }
  } finally {
    await admin.close();
  }
}
