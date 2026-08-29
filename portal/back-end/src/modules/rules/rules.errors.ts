/**
 * T-031 — the domain-specific error codes `/rules` introduces, on top of the generic
 * catalogue `common/errors/app-error.ts` already provides.
 *
 * None of these has a `system_messages` row yet (the same deviation `countries.errors.ts`
 * records for T-030's own new codes, and `auth.exceptions.ts` for T-011's): `MessageService`
 * degrades to returning the key itself, which is safe — no internal detail — but unlocalised
 * until a seed migration adds them. Seed migrations are outside this module's file scope
 * (`back-end/src/database/migrations/**`).
 *
 * ### Why "the list of campaigns"/"the list of countries" is ids only, in `details`
 *
 * `AppError.details` is typed `readonly ErrorDetail[]` — `{ field, code }` pairs, each
 * checked against `SAFE_FIELD_PATTERN`/`SAFE_ERROR_CODE_PATTERN` by
 * `ErrorNormalizationFilter` before it ever reaches a response (`app-error.ts`: *"Nothing a
 * client receives is derived from the text of an error"*). A campaign or country **name** is
 * free text and cannot pass that filter — nor should it, since the whole point of the pattern
 * is that arbitrary text never reaches an error body. The blocking rows' **ids** do fit the
 * pattern and are what these two errors surface; a caller that needs the human-readable name
 * already has (or can fetch) the country/campaign list separately. `logContext` carries the
 * richer, human-readable form for the server log only — never serialised to a client.
 */
import { BusinessRuleError, ConflictError, type AppErrorOptions } from '@/common/errors/app-error';

/**
 * `INVALID_RULE_PARAMETERS`/TC-14 is **not** one of these: `parameters` is validated entirely
 * by `dto/rule-validators.decorators.ts`'s `@IsRuleParameters()`, which fails through the same
 * `class-validator` → `validationExceptionFactory` pipeline every other DTO field uses — a 400
 * `VALIDATION_FAILED` with `details: [{ field: 'parameters', code: 'IS_RULE_PARAMETERS' }]`, a
 * "specific message" (TC-14's own wording) with no second error type needed for it.
 */
export const RULE_ERROR_CODE = Object.freeze({
  /** `uq_rm_tenant_code` — a global rule's `rule_code` is already in use (TC-18). */
  RULE_CODE_EXISTS: 'RULE_CODE_EXISTS',
  /** `DELETE /rules/:id` while the rule still holds a country assignment (TC-20). */
  RULE_HAS_COUNTRY_ASSIGNMENTS: 'RULE_HAS_COUNTRY_ASSIGNMENTS',
  /** Unassigning a rule a campaign is actively bound to (implementation note 6, TC-12). */
  RULE_IN_USE_BY_CAMPAIGN: 'RULE_IN_USE_BY_CAMPAIGN',
  /** T-106 — `uq_rc_tenant_code` — a category code is already in use. */
  RULE_CATEGORY_CODE_EXISTS: 'RULE_CATEGORY_CODE_EXISTS',
  /** T-106 — `uq_rsc_category_code` — a sub-category code is already in use under that category. */
  RULE_SUB_CATEGORY_CODE_EXISTS: 'RULE_SUB_CATEGORY_CODE_EXISTS',
});

/** 409 — `POST /rules` with a `ruleCode` already in use by another global rule (TC-18). */
export class RuleCodeExistsError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(RULE_ERROR_CODE.RULE_CODE_EXISTS, options);
  }
}

/** T-106 — 409 — `POST /rule-categories` with a `categoryCode` already in use. */
export class RuleCategoryCodeExistsError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(RULE_ERROR_CODE.RULE_CATEGORY_CODE_EXISTS, options);
  }
}

/** T-106 — 409 — `POST /rule-sub-categories` with a `subCategoryCode` already in use under
 * that category. */
export class RuleSubCategoryCodeExistsError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(RULE_ERROR_CODE.RULE_SUB_CATEGORY_CODE_EXISTS, options);
  }
}

/** 422 — `DELETE /rules/:id` while `rule_country_assignments` still holds a row (TC-20).
 * `details` carries each blocking `countryId` as `{ field: 'countryId', code: 'COUNTRY_<id>' }`. */
export class RuleHasCountryAssignmentsError extends BusinessRuleError {
  constructor(countryIds: readonly number[], options: AppErrorOptions = {}) {
    super(RULE_ERROR_CODE.RULE_HAS_COUNTRY_ASSIGNMENTS, {
      ...options,
      details: countryIds.map((id) => ({ field: 'countryId', code: `COUNTRY_${id}` })),
      logContext: { ...options.logContext, countryIds },
    });
  }
}

/**
 * 422 — unassigning a rule that an active campaign is bound to (implementation note 6,
 * TC-12). `details` carries each blocking campaign as
 * `{ field: 'campaignId', code: 'CAMPAIGN_<id>' }` — see the file header for why the name is
 * not included. `campaigns` (with names, for the server log) is on `logContext` only.
 */
export class RuleInUseByCampaignError extends BusinessRuleError {
  constructor(
    campaigns: readonly { readonly id: number; readonly name: string }[],
    options: AppErrorOptions = {},
  ) {
    super(RULE_ERROR_CODE.RULE_IN_USE_BY_CAMPAIGN, {
      ...options,
      details: campaigns.map((campaign) => ({
        field: 'campaignId',
        code: `CAMPAIGN_${campaign.id}`,
      })),
      logContext: { ...options.logContext, campaigns },
    });
  }
}
