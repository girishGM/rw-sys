/**
 * T-031 implementation note 6 / TC-12 — "Unassigning a rule that is in use by an active
 * campaign → 422 with the list of campaigns, not a silent break."
 *
 * ### Why this is a hand-written parameterised query, not a `ScopedRepository` call
 *
 * The join this check needs — `rule_master` → `tracker_component_rules` →
 * `tracker_components` → `tracker_tracker_components` → `trackers` →
 * `tenant_campaign_trackers` → `tenant_campaigns` — walks through three
 * `reward_config` tables (`tracker_component_rules`, `tracker_components`,
 * `tracker_tracker_components`) that T-037 (the campaign wizard, the task that owns the
 * tracker/component hierarchy — 06-VERSIONING.md's impact table, gap G16) has not modelled
 * in Sequelize yet, and `back-end/src/database/models/**`/`back-end/src/common/scope/**` are
 * outside this task's file scope (AGENT-PROTOCOL R9) — adding models or a `scope-strategy.ts`
 * entry for them is T-037's call to make, not this task's to reach across and take.
 *
 * `session.repository.ts` and `notifications.repository.ts` (both T-011/T-040) already
 * establish the precedent this file follows for exactly this situation: a raw,
 * parameterised `sequelize.query()` against a table with no Sequelize model, values bound
 * through `replacements` (never interpolated), for a table this task's own actor
 * (`reward_app`) is independently confirmed to hold real `SELECT` privilege on — checked
 * against the live database with `has_table_privilege()` before this file was written,
 * because 01-DATABASE.md §3's own documented `GRANT` list does not mention
 * `tracker_component_rules` and the two could easily have disagreed. This is **not** a
 * `ScopedRepository` bypass in the R2 sense: R2 exists to keep a cross-tenant row
 * unreachable, and this call only ever runs from `RuleService.unassignFromCountry`, which
 * `assertRole(actor, 'super_admin')` has already gated — a `super_admin` scope has no
 * tenant restriction to bypass in the first place (`scope-strategy.ts`'s own `super_admin`
 * short-circuit).
 *
 * ### The one thing this file could not resolve on its own — escalated, not guessed
 *
 * "Active campaign" is `tenant_campaigns.status = 'active'` here, the literal word the task's
 * own TC-12 uses. At the time this was written the live database holds **zero** rows in
 * `tenant_campaigns` at all (T-037 has not shipped), so this status value could not be
 * confirmed against real data the way `ck_rm_status` could — only against the `create-
 * campaign` agents' design docs and the DDL's own `status varchar(20) default 'draft'` with
 * no `CHECK` constraint. T-037 owns the campaign status lifecycle end to end; if it lands on
 * a richer in-flight vocabulary (`pending_approval`, `approved`, …) than the single value
 * `ACTIVE_CAMPAIGN_STATUSES` narrows to today, this function's constant is the one line to
 * revisit. Flagged for the reviewer and for whoever picks up T-037.
 */
import { QueryTypes, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { ACTIVE_CAMPAIGN_STATUSES } from './rules.constants';

export interface CampaignUsingRule {
  readonly id: number;
  readonly name: string;
}

interface CampaignUsingRuleRow {
  readonly id: number;
  readonly name: string;
}

/**
 * The active campaigns, in `countryId`, whose journey is bound to `ruleId` via
 * `tracker_component_rules`. Empty when the rule is not (yet) reachable by any campaign —
 * which, until T-037 ships, is every rule.
 */
export async function findActiveCampaignsUsingRuleInCountry(
  sequelize: Sequelize,
  ruleId: number,
  countryId: number,
  transaction?: Transaction,
): Promise<readonly CampaignUsingRule[]> {
  const rows = await sequelize.query<CampaignUsingRuleRow>(
    `SELECT DISTINCT camp.id AS id, camp.name AS name
       FROM reward_config.tracker_component_rules tcr
       JOIN reward_config.tracker_components tcomp
         ON tcomp.id = tcr.tracker_component_id
       JOIN reward_config.tracker_tracker_components ttc
         ON ttc.component_id = tcomp.id
       JOIN reward_config.tenant_campaign_trackers tct
         ON tct.tracker_id = ttc.tracker_id
       JOIN reward_config.tenant_campaigns camp
         ON camp.id = tct.campaign_id
       JOIN reward_config.tenants ten
         ON ten.id = camp.tenant_id
      WHERE tcr.rule_id = :ruleId
        AND ten.country_id = :countryId
        AND camp.deleted_at IS NULL
        AND camp.status IN (:activeStatuses)
        AND tct.status = 'active'
      ORDER BY camp.id`,
    {
      type: QueryTypes.SELECT,
      replacements: { ruleId, countryId, activeStatuses: [...ACTIVE_CAMPAIGN_STATUSES] },
      transaction,
    },
  );

  return rows.map((row) => ({ id: row.id, name: row.name }));
}
