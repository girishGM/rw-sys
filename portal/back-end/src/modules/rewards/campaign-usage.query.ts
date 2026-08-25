/**
 * T-032 TC-9 — "Unassign a reward that is in use by an active campaign → 422 with the list of
 * campaigns, not a silent break." The reward equivalent of `rules/campaign-usage.query.ts`
 * (T-031), and considerably simpler: rewards bind to a campaign directly through
 * `reward_campaign_assignments` (`reward_policy_id` → `campaign_id`), with no tracker/component
 * hierarchy in between — that table did not need T-037's not-yet-modelled tracker chain the rule
 * side does, so this join needed no escalation.
 *
 * Still a hand-written parameterised query rather than a `ScopedRepository` call, for the same
 * reason as `rules/campaign-usage.query.ts`: `reward_campaign_assignments` and `tenant_campaigns`
 * are `reward_config` tables outside this task's model-owning scope, and `reward_app`'s live
 * `SELECT` privilege on both (plus `reward_config.tenants`) was independently confirmed against
 * the real database before this file was written (T-032 completion report).
 *
 * "Active campaign" is `tenant_campaigns.status = 'active'` and
 * `reward_campaign_assignments.status = 'active'`, the same literal-word narrowing
 * `rules/campaign-usage.query.ts` documents at length for its own `ACTIVE_CAMPAIGN_STATUSES` —
 * see that file's header for the full reasoning and the T-037 escalation it already carries.
 */
import { QueryTypes, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { ACTIVE_CAMPAIGN_STATUSES } from './rewards.constants';

export interface CampaignUsingReward {
  readonly id: number;
  readonly name: string;
}

interface CampaignUsingRewardRow {
  readonly id: number;
  readonly name: string;
}

/**
 * The active campaigns, in `countryId`, whose reward binding traces back to `rewardSystemId` via
 * any of its `reward_policies`. Empty when the reward is not (yet) bound to any campaign — which,
 * until T-037 ships, is every reward.
 */
export async function findActiveCampaignsUsingRewardInCountry(
  sequelize: Sequelize,
  rewardSystemId: number,
  countryId: number,
  transaction?: Transaction,
): Promise<readonly CampaignUsingReward[]> {
  const rows = await sequelize.query<CampaignUsingRewardRow>(
    `SELECT DISTINCT camp.id AS id, camp.name AS name
       FROM reward_config.reward_campaign_assignments rca
       JOIN reward_config.reward_policies rp
         ON rp.id = rca.reward_policy_id
       JOIN reward_config.tenant_campaigns camp
         ON camp.id = rca.campaign_id
       JOIN reward_config.tenants ten
         ON ten.id = camp.tenant_id
      WHERE rp.reward_system_id = :rewardSystemId
        AND ten.country_id = :countryId
        AND camp.deleted_at IS NULL
        AND camp.status IN (:activeStatuses)
        AND rca.status = 'active'
      ORDER BY camp.id`,
    {
      type: QueryTypes.SELECT,
      replacements: {
        rewardSystemId,
        countryId,
        activeStatuses: [...ACTIVE_CAMPAIGN_STATUSES],
      },
      transaction,
    },
  );

  return rows.map((row) => ({ id: row.id, name: row.name }));
}
