/**
 * T-041 implementation note 7 / TC-21 — "Withdrawing a version from a country → 422 listing the
 * campaigns still bound to it." Also the source of `BlastsService.preview`'s
 * `activeCampaignsOnCurrentVersion` count (implementation note 6).
 *
 * The version-aware sibling of `rules/campaign-usage.query.ts` (T-031) / `rewards/campaign-usage.query.ts`
 * (T-032): those filter by `rule_id`/`reward_system_id` (any version); these filter by the
 * concrete `rule_version_id`/`reward_version_id` `tracker_component_rules`/
 * `reward_campaign_assignments` pin at bind time (06-VERSIONING.md §7 — "the binding pin"). Same
 * hand-written, parameterised-`sequelize.query()` shape and the same reasoning for it: the
 * tracker/component hierarchy is T-037's, not yet modelled in Sequelize, and this task's file
 * scope (`back-end/src/modules/versions/**`) does not extend to adding models for it
 * (AGENT-PROTOCOL R9). `reward_app`'s `SELECT` privilege on every table these queries touch
 * was already confirmed live by T-031/T-032, whose queries this file mirrors column-for-column.
 *
 * "Active campaign" is `tenant_campaigns.status = 'active'`, the same narrowing
 * `ACTIVE_CAMPAIGN_STATUSES` documents in `versions.constants.ts` — T-037 had not shipped at
 * the time this was written, and `tenant_campaigns`/`tracker_component_rules.rule_version_id`/
 * `reward_campaign_assignments.reward_version_id` hold **zero** rows in the live database as of
 * this task, so the constant could not be confirmed against real data either; flagged for
 * whoever picks up T-037, same as the two files this one mirrors.
 */
import { QueryTypes, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { ACTIVE_CAMPAIGN_STATUSES } from './versions.constants';

export interface CampaignUsingVersion {
  readonly id: number;
  readonly name: string;
}

interface CampaignRow {
  readonly id: number;
  readonly name: string;
}

/** The active campaigns, in `countryId`, whose journey is pinned to `ruleVersionId` via
 * `tracker_component_rules.rule_version_id`. */
export async function findActiveCampaignsUsingRuleVersionInCountry(
  sequelize: Sequelize,
  ruleVersionId: number,
  countryId: number,
  transaction?: Transaction,
): Promise<readonly CampaignUsingVersion[]> {
  const rows = await sequelize.query<CampaignRow>(
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
      WHERE tcr.rule_version_id = :ruleVersionId
        AND ten.country_id = :countryId
        AND camp.deleted_at IS NULL
        AND camp.status IN (:activeStatuses)
        AND tct.status = 'active'
      ORDER BY camp.id`,
    {
      type: QueryTypes.SELECT,
      replacements: { ruleVersionId, countryId, activeStatuses: [...ACTIVE_CAMPAIGN_STATUSES] },
      transaction,
    },
  );

  return rows.map((row) => ({ id: row.id, name: row.name }));
}

/** The active campaigns, in `countryId`, bound to `rewardVersionId` via
 * `reward_campaign_assignments.reward_version_id`. */
export async function findActiveCampaignsUsingRewardVersionInCountry(
  sequelize: Sequelize,
  rewardVersionId: number,
  countryId: number,
  transaction?: Transaction,
): Promise<readonly CampaignUsingVersion[]> {
  const rows = await sequelize.query<CampaignRow>(
    `SELECT DISTINCT camp.id AS id, camp.name AS name
       FROM reward_config.reward_campaign_assignments rca
       JOIN reward_config.tenant_campaigns camp
         ON camp.id = rca.campaign_id
       JOIN reward_config.tenants ten
         ON ten.id = camp.tenant_id
      WHERE rca.reward_version_id = :rewardVersionId
        AND ten.country_id = :countryId
        AND camp.deleted_at IS NULL
        AND camp.status IN (:activeStatuses)
        AND rca.status = 'active'
      ORDER BY camp.id`,
    {
      type: QueryTypes.SELECT,
      replacements: { rewardVersionId, countryId, activeStatuses: [...ACTIVE_CAMPAIGN_STATUSES] },
      transaction,
    },
  );

  return rows.map((row) => ({ id: row.id, name: row.name }));
}
