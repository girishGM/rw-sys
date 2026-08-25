/**
 * T-037 — the domain-specific error codes `/campaigns` introduces, on top of the generic
 * catalogue `common/errors/app-error.ts` provides.
 *
 * None of these has a `system_messages` row yet — the same deviation `rules.errors.ts`,
 * `countries.errors.ts` and `auth.exceptions.ts` each record for their own new codes.
 * `MessageService` degrades to returning the key, which is safe (no internal detail) but
 * unlocalised until a seed migration adds them; seed migrations live in
 * `back-end/src/database/migrations/**`, outside this module's file scope.
 *
 * ### Why {@link RuleNotAssignedToCountryError} is a 400 and not the usual 404
 *
 * 02-SECURITY.md §5.1's rule — *"not found and out of scope are deliberately
 * indistinguishable"* — exists to stop an attacker enumerating **another tenant's data**. A
 * global rule is not that: `rule_master` rows with `tenant_id IS NULL` are Super-Admin-authored
 * configuration, identical for every tenant, and their ids are already visible to every maker in
 * every country the rule *is* assigned to. Meanwhile T-037's own TC-15 and Verification step 5
 * are explicit and repeated on the point: attaching an unassigned rule must be **400**, *"not a
 * silent skip that yields a campaign missing a rule the maker believed they added"* — the
 * failure mode being guarded here is a maker shipping a broken campaign, and a 404 saying
 * "campaign not found" in response to a rule id would actively mislead them. The task file wins
 * over the general convention here; flagged in the completion report either way.
 */
import {
  AppError,
  BusinessRuleError,
  ConflictError,
  ERROR_CODE,
  type AppErrorOptions,
  type ErrorDetail,
} from '@/common/errors/app-error';

export const CAMPAIGN_ERROR_CODE = Object.freeze({
  /** `uq_tc_tenant_code` — this tenant already has a campaign with that code (TC-6). */
  CAMPAIGN_CODE_EXISTS: 'CAMPAIGN_CODE_EXISTS',
  /** An edit attempted on a campaign that is not editable (implementation note 3). */
  CAMPAIGN_NOT_EDITABLE: 'CAMPAIGN_NOT_EDITABLE',
  /** A state transition the machine does not permit (implementation note 3). */
  CAMPAIGN_TRANSITION_NOT_ALLOWED: 'CAMPAIGN_TRANSITION_NOT_ALLOWED',
  /** A rule id outside `ruleVisibilityScope()` (implementation note 7, TC-15). */
  RULE_NOT_ASSIGNED_TO_COUNTRY: 'RULE_NOT_ASSIGNED_TO_COUNTRY',
  /** A reward policy outside the actor's country's assigned set (TC-21). */
  REWARD_NOT_ASSIGNED_TO_COUNTRY: 'REWARD_NOT_ASSIGNED_TO_COUNTRY',
  /** A merchant id from another tenant, or one that does not exist (TC-13). */
  MERCHANT_NOT_IN_TENANT: 'MERCHANT_NOT_IN_TENANT',
  /** An activity no merchant chosen in step 2 offers (implementation note 8, TC-21h). */
  ACTIVITY_NOT_OFFERED_BY_CAMPAIGN_MERCHANTS: 'ACTIVITY_NOT_OFFERED_BY_CAMPAIGN_MERCHANTS',
  /** `n_of` threshold below 1 or above the component count (note 4, TC-21e/f/g). */
  UNACHIEVABLE_COMPLETION_THRESHOLD: 'UNACHIEVABLE_COMPLETION_THRESHOLD',
  /** A tracker or component id that does not belong to this campaign (TC-21q). */
  NOT_PART_OF_CAMPAIGN: 'NOT_PART_OF_CAMPAIGN',
  /** Structural validation failed at submit (note 19, TC-21i/j/o). */
  CAMPAIGN_STRUCTURE_INCOMPLETE: 'CAMPAIGN_STRUCTURE_INCOMPLETE',
  /** The tenant budget ceiling, enforced at submit (note 17, TC-21ff/kk). */
  BUDGET_EXCEEDS_TENANT_CEILING: 'BUDGET_EXCEEDS_TENANT_CEILING',
  /** A cap in a currency other than the campaign's, without confirmation (TC-21bb). */
  CAP_CURRENCY_MISMATCH_UNCONFIRMED: 'CAP_CURRENCY_MISMATCH_UNCONFIRMED',
  /** The same reward policy attached twice at the same level (`uq_rca_*`). */
  REWARD_ALREADY_ATTACHED: 'REWARD_ALREADY_ATTACHED',
  /** The same rule bound twice to one component. */
  RULE_ALREADY_BOUND: 'RULE_ALREADY_BOUND',
  /** A generated tracker/component code could not be made unique — see `CODE_GENERATION_ATTEMPTS`. */
  CODE_GENERATION_FAILED: 'CODE_GENERATION_FAILED',
});

/** 409 — `POST /campaigns` with a `campaignCode` already used in this tenant (TC-6). A different
 * tenant using the same code is fine and must stay fine (TC-7): the constraint is per tenant. */
export class CampaignCodeExistsError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(CAMPAIGN_ERROR_CODE.CAMPAIGN_CODE_EXISTS, options);
  }
}

/**
 * 409 — an edit on a campaign that is not in an editable state (implementation note 3:
 * *"Editing allowed only in `draft`/`returned`"*).
 *
 * A 409 rather than a 403: the caller has every permission required, and would succeed on the
 * same route a moment earlier or after a checker returns the campaign. That is the definition of
 * a conflict with current state, and 03-API-CONTRACT.md §1 assigns 409 to exactly *"state
 * transition not allowed"*.
 */
export class CampaignNotEditableError extends ConflictError {
  constructor(status: string, options: AppErrorOptions = {}) {
    super(CAMPAIGN_ERROR_CODE.CAMPAIGN_NOT_EDITABLE, {
      ...options,
      logContext: { ...options.logContext, status },
    });
  }
}

/** 409 — an illegal transition (implementation note 3). */
export class CampaignTransitionNotAllowedError extends ConflictError {
  constructor(from: string, to: string, options: AppErrorOptions = {}) {
    super(CAMPAIGN_ERROR_CODE.CAMPAIGN_TRANSITION_NOT_ALLOWED, {
      ...options,
      logContext: { ...options.logContext, from, to },
    });
  }
}

/** 400 — see this file's header for why this is not a 404 (TC-15, Verification step 5). */
export class RuleNotAssignedToCountryError extends AppError {
  constructor(ruleId: number, options: AppErrorOptions = {}) {
    super(CAMPAIGN_ERROR_CODE.RULE_NOT_ASSIGNED_TO_COUNTRY, 400, {
      ...options,
      details: [{ field: 'ruleId', code: `RULE_${ruleId}` }],
      logContext: { ...options.logContext, ruleId },
    });
  }
}

/** 400 — the reward mirror of {@link RuleNotAssignedToCountryError} (TC-21). */
export class RewardNotAssignedToCountryError extends AppError {
  constructor(rewardPolicyId: number, options: AppErrorOptions = {}) {
    super(CAMPAIGN_ERROR_CODE.REWARD_NOT_ASSIGNED_TO_COUNTRY, 400, {
      ...options,
      details: [{ field: 'rewardPolicyId', code: `POLICY_${rewardPolicyId}` }],
      logContext: { ...options.logContext, rewardPolicyId },
    });
  }
}

/**
 * 400 — a merchant id that is not in the actor's tenant (TC-13: *"400/404; no row written"*).
 *
 * Unlike the rule/reward case above, this one **is** tenant data, so nothing about the other
 * tenant's merchant is revealed: the code and `details` say only that the id supplied is not
 * usable here, which is exactly what a maker who mistyped an id needs to know and exactly what
 * an attacker probing for another tenant's merchant ids already knew before asking.
 */
export class MerchantNotInTenantError extends AppError {
  constructor(merchantIds: readonly number[], options: AppErrorOptions = {}) {
    super(CAMPAIGN_ERROR_CODE.MERCHANT_NOT_IN_TENANT, 400, {
      ...options,
      details: merchantIds.map((id) => ({ field: 'merchantIds', code: `MERCHANT_${id}` })),
      logContext: { ...options.logContext, merchantIds },
    });
  }
}

/** 400 — implementation note 8 / TC-21h. The client-side filter is convenience; this is the
 * control. */
export class ActivityNotOfferedError extends AppError {
  constructor(activityId: number, options: AppErrorOptions = {}) {
    super(CAMPAIGN_ERROR_CODE.ACTIVITY_NOT_OFFERED_BY_CAMPAIGN_MERCHANTS, 400, {
      ...options,
      details: [{ field: 'activityId', code: `ACTIVITY_${activityId}` }],
      logContext: { ...options.logContext, activityId },
    });
  }
}

/**
 * 400 — an `n_of` threshold that no customer could ever satisfy (implementation note 4,
 * TC-21e/TC-21f/TC-21g).
 *
 * *"A threshold above the count creates a tracker no customer can ever complete"* — and, unlike
 * most misconfigurations, one that looks entirely valid on screen and fails silently in
 * production months later. It is rejected at the write that would create it, in the service,
 * because neither the database (no CHECK spans two tables) nor the client can enforce it.
 */
export class UnachievableThresholdError extends AppError {
  constructor(threshold: number, componentCount: number, options: AppErrorOptions = {}) {
    super(CAMPAIGN_ERROR_CODE.UNACHIEVABLE_COMPLETION_THRESHOLD, 400, {
      ...options,
      details: [{ field: 'completionThreshold', code: `MAX_${componentCount}` }],
      logContext: { ...options.logContext, threshold, componentCount },
    });
  }
}

/**
 * 400 — a tracker/component id that exists but belongs to a different campaign (TC-21q).
 *
 * Deliberately distinct from a 404: the row is inside the actor's own tenant and the actor may
 * legitimately see it, so "not found" would be untrue. What is wrong is the *relationship*, and
 * saying so is what lets a maker understand that they picked a component from another campaign.
 */
export class NotPartOfCampaignError extends AppError {
  constructor(field: string, id: number, options: AppErrorOptions = {}) {
    super(CAMPAIGN_ERROR_CODE.NOT_PART_OF_CAMPAIGN, 400, {
      ...options,
      details: [{ field, code: `ID_${id}` }],
      logContext: { ...options.logContext, field, id },
    });
  }
}

/** 422 — structural validation failed at submit (implementation note 19). `details` carries one
 * entry per problem, so step 7 shows the maker everything at once. */
export class CampaignStructureIncompleteError extends BusinessRuleError {
  constructor(details: readonly ErrorDetail[], options: AppErrorOptions = {}) {
    super(CAMPAIGN_ERROR_CODE.CAMPAIGN_STRUCTURE_INCOMPLETE, { ...options, details });
  }
}

/**
 * 422 `BUDGET_EXCEEDS_TENANT_CEILING` — 11-BUDGETS-AND-LIMITS.md §8.4, implementation note 17.
 *
 * Thrown by `CampaignsService.submit`, **not** by the controller and **not** by any draft-saving
 * path: *"Draft saving is never blocked — a maker may draft anything; the gate is submission"*
 * (TC-21gg). Its whole point is TC-21kk — *"submit-time ceiling check bypassed by direct `curl`
 * → still 422"* — so it must live where a request that never touched the wizard still meets it.
 */
export class BudgetExceedsTenantCeilingError extends BusinessRuleError {
  constructor(
    breaches: readonly { readonly unitType: string; readonly unitCode: string }[],
    options: AppErrorOptions = {},
  ) {
    super(CAMPAIGN_ERROR_CODE.BUDGET_EXCEEDS_TENANT_CEILING, {
      ...options,
      details: breaches.map((breach) => ({
        field: 'budgetAmount',
        code: `UNIT_${breach.unitCode}`,
      })),
      logContext: { ...options.logContext, breaches },
    });
  }
}

/** 400 — TC-21bb: a cap in a currency other than the campaign's needs one deliberate
 * acknowledgement (`confirmCurrencyMismatch`) rather than a silent accept. */
export class CapCurrencyMismatchError extends AppError {
  constructor(unitCodes: readonly string[], options: AppErrorOptions = {}) {
    super(CAMPAIGN_ERROR_CODE.CAP_CURRENCY_MISMATCH_UNCONFIRMED, 400, {
      ...options,
      details: unitCodes.map((code) => ({ field: 'caps', code: `UNIT_${code}` })),
      logContext: { ...options.logContext, unitCodes },
    });
  }
}

/** 409 — `uq_rca_unique` / `uq_rta_unique` / `uq_rca_camp_unique`. */
export class RewardAlreadyAttachedError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(CAMPAIGN_ERROR_CODE.REWARD_ALREADY_ATTACHED, options);
  }
}

/** 409 — the same rule bound twice to one component. `tracker_component_rules` carries no unique
 * constraint for this (confirmed live: only the primary key and three FKs), so unlike every
 * other duplicate in this file it is detected by the service rather than by the database. */
export class RuleAlreadyBoundError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(CAMPAIGN_ERROR_CODE.RULE_ALREADY_BOUND, options);
  }
}

/** 500-class — see `CODE_GENERATION_ATTEMPTS`. Not a client error: nothing the caller sent
 * caused it, and there is nothing they can change to avoid it. */
export class CodeGenerationFailedError extends AppError {
  constructor(prefix: string, options: AppErrorOptions = {}) {
    super(ERROR_CODE.INTERNAL_ERROR, 500, {
      ...options,
      logMessage: `Could not generate a unique ${prefix} code after repeated attempts`,
      logContext: { ...options.logContext, prefix },
    });
  }
}
