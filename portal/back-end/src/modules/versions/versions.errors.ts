/**
 * T-041 — the domain-specific error codes `/rules/:id/versions` and `/rewards/:id/versions`
 * introduce, on top of the generic catalogue `common/errors/app-error.ts` already provides.
 *
 * None of these has a `system_messages` row yet — the same deviation `rules.errors.ts`
 * (T-031) records for its own new codes: seed migrations are outside this module's file scope
 * (`back-end/src/database/migrations/**`).
 */
import { BusinessRuleError, ConflictError, type AppErrorOptions } from '@/common/errors/app-error';

export const VERSION_ERROR_CODE = Object.freeze({
  /** `uq_rv_one_draft`/`uq_rewv_one_draft` — a second concurrent draft attempt (TC-2). */
  VERSION_DRAFT_ALREADY_EXISTS: 'VERSION_DRAFT_ALREADY_EXISTS',
  /** Editing, publishing, deprecating or retiring a version whose current `status` does not
   * allow the requested transition (TC-4, TC-6). */
  VERSION_INVALID_TRANSITION: 'VERSION_INVALID_TRANSITION',
  /** `isBreaking` supplied and disagrees with the system's own suggestion, with no
   * `confirmBreakingOverride: true` (implementation note 9). */
  VERSION_BREAKING_CONFIRMATION_REQUIRED: 'VERSION_BREAKING_CONFIRMATION_REQUIRED',
  /** Withdrawing a version from a country while a campaign is still bound to it (TC-21). */
  VERSION_HAS_CAMPAIGNS: 'VERSION_HAS_CAMPAIGNS',
});

/** 409 — a second draft already exists for this rule/reward (TC-2). */
export class VersionDraftAlreadyExistsError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(VERSION_ERROR_CODE.VERSION_DRAFT_ALREADY_EXISTS, options);
  }
}

/** 409 — the version is not in the state the requested transition needs (TC-4, TC-6): editing a
 * published version, publishing an already-published one, deprecating a draft, retiring a
 * published-not-yet-deprecated one. */
export class VersionInvalidTransitionError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(VERSION_ERROR_CODE.VERSION_INVALID_TRANSITION, options);
  }
}

/** 422 — `isBreaking` was supplied and diverges from the system's suggestion, with no
 * confirmation (implementation note 9). */
export class VersionBreakingConfirmationRequiredError extends BusinessRuleError {
  constructor(suggested: boolean, options: AppErrorOptions = {}) {
    super(VERSION_ERROR_CODE.VERSION_BREAKING_CONFIRMATION_REQUIRED, {
      ...options,
      details: [{ field: 'isBreaking', code: suggested ? 'SUGGESTED_TRUE' : 'SUGGESTED_FALSE' }],
      logContext: { ...options.logContext, suggested },
    });
  }
}

/**
 * 422 — withdrawing a version from a country an active campaign is still bound to (TC-21).
 * `details` carries each blocking campaign as `{ field: 'campaignId', code: 'CAMPAIGN_<id>' }` —
 * the same `RuleInUseByCampaignError` shape, and for the same reason (`rules.errors.ts`'s own
 * header: a campaign name is free text and cannot pass `SAFE_FIELD_PATTERN`/
 * `SAFE_ERROR_CODE_PATTERN`).
 */
export class VersionHasCampaignsError extends BusinessRuleError {
  constructor(
    campaigns: readonly { readonly id: number; readonly name: string }[],
    options: AppErrorOptions = {},
  ) {
    super(VERSION_ERROR_CODE.VERSION_HAS_CAMPAIGNS, {
      ...options,
      details: campaigns.map((campaign) => ({
        field: 'campaignId',
        code: `CAMPAIGN_${campaign.id}`,
      })),
      logContext: { ...options.logContext, campaigns },
    });
  }
}
