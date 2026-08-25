/**
 * T-032 — the domain-specific error codes `/rewards` introduces, on top of the generic
 * catalogue `common/errors/app-error.ts` already provides. The reward equivalent of
 * `rules.errors.ts` (T-031) — see that file's header for why `details` carries ids only, never
 * a country/campaign/policy name.
 *
 * None of these has a `system_messages` row yet — the same disclosed deviation `rules.errors.ts`
 * records for T-031's own new codes. Seed migrations are outside this module's file scope
 * (`back-end/src/database/migrations/**`).
 */
import { BusinessRuleError, ConflictError, type AppErrorOptions } from '@/common/errors/app-error';

export const REWARD_ERROR_CODE = Object.freeze({
  /** `uc_reward_system_code` — a global reward's `systemCode` is already in use (TC-16). */
  REWARD_SYSTEM_CODE_EXISTS: 'REWARD_SYSTEM_CODE_EXISTS',
  /** `DELETE /rewards/:id` while the reward still holds a country assignment (TC-20). */
  REWARD_HAS_COUNTRY_ASSIGNMENTS: 'REWARD_HAS_COUNTRY_ASSIGNMENTS',
  /** Unassigning a reward a campaign is actively bound to (TC-9). */
  REWARD_IN_USE_BY_CAMPAIGN: 'REWARD_IN_USE_BY_CAMPAIGN',
  /** `uq_rp_system_code` — a policy's `policyCode` is already in use on this reward (TC-18). */
  REWARD_POLICY_CODE_EXISTS: 'REWARD_POLICY_CODE_EXISTS',
});

/** 409 — `POST /rewards` with a `systemCode` already in use by another global reward (TC-16). */
export class RewardSystemCodeExistsError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(REWARD_ERROR_CODE.REWARD_SYSTEM_CODE_EXISTS, options);
  }
}

/** 422 — `DELETE /rewards/:id` while `reward_country_assignments` still holds a row (TC-20).
 * `details` carries each blocking `countryId` as `{ field: 'countryId', code: 'COUNTRY_<id>' }`. */
export class RewardHasCountryAssignmentsError extends BusinessRuleError {
  constructor(countryIds: readonly number[], options: AppErrorOptions = {}) {
    super(REWARD_ERROR_CODE.REWARD_HAS_COUNTRY_ASSIGNMENTS, {
      ...options,
      details: countryIds.map((id) => ({ field: 'countryId', code: `COUNTRY_${id}` })),
      logContext: { ...options.logContext, countryIds },
    });
  }
}

/**
 * 422 — unassigning a reward that an active campaign is bound to (TC-9). `details` carries each
 * blocking campaign as `{ field: 'campaignId', code: 'CAMPAIGN_<id>' }` — see `rules.errors.ts`'s
 * header for why the name is not included. `campaigns` (with names, for the server log) is on
 * `logContext` only.
 */
export class RewardInUseByCampaignError extends BusinessRuleError {
  constructor(
    campaigns: readonly { readonly id: number; readonly name: string }[],
    options: AppErrorOptions = {},
  ) {
    super(REWARD_ERROR_CODE.REWARD_IN_USE_BY_CAMPAIGN, {
      ...options,
      details: campaigns.map((campaign) => ({
        field: 'campaignId',
        code: `CAMPAIGN_${campaign.id}`,
      })),
      logContext: { ...options.logContext, campaigns },
    });
  }
}

/** 409 — `POST /rewards/:id/policies` with a `policyCode` already in use on this reward (TC-18). */
export class RewardPolicyCodeExistsError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(REWARD_ERROR_CODE.REWARD_POLICY_CODE_EXISTS, options);
  }
}
