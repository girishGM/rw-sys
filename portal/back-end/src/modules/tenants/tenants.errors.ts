/**
 * T-034 — the domain-specific error codes `/tenants` introduces, on top of the generic
 * catalogue `common/errors/app-error.ts` already provides.
 *
 * None of these has a `system_messages` row yet — the same disclosed deviation
 * `countries.errors.ts` records for its own new codes: `MessageService` degrades to returning
 * the key itself, which is safe (no internal detail) but unlocalised until a seed migration
 * adds them. Seed migrations are outside this module's file scope
 * (`back-end/src/database/migrations/**`, save for the one T-046 migration this task does not
 * touch either).
 */
import { BusinessRuleError, ConflictError, type AppErrorOptions } from '@/common/errors/app-error';

export const TENANT_ERROR_CODE = Object.freeze({
  /** `uq_tenants_code` — mapped away from the raw constraint name (implementation note 2's
   * sibling discipline, T-030's own precedent). */
  TENANT_CODE_EXISTS: 'TENANT_CODE_EXISTS',
  /** `uq_tenants_schema_prefix` (TC-11). */
  TENANT_SCHEMA_PREFIX_EXISTS: 'TENANT_SCHEMA_PREFIX_EXISTS',
  /** `uq_portal_users_email_live` on the Tenant Admin being onboarded. */
  TENANT_ADMIN_EMAIL_EXISTS: 'TENANT_ADMIN_EMAIL_EXISTS',
  /** `POST /:id/activate` on a tenant that is not `pending_provisioning` (TC-16). */
  TENANT_ALREADY_ACTIVE: 'TENANT_ALREADY_ACTIVE',
  /** 422 — a write against a tenant that is not `active` (implementation note 3; reused by
   * whichever module later enforces it against campaign creation, TC-17). */
  TENANT_NOT_ACTIVE: 'TENANT_NOT_ACTIVE',
  /** 400 — `warnAboveAmount` above `maxCampaignBudget` (`ck_tbc_warn`, TC-27). Raised from the DTO
   * layer as a validation failure, not from here — kept in the catalogue for completeness and for
   * `tenants.errors.spec.ts`'s "every code is UPPER_SNAKE_CASE" sweep. */
  TENANT_BUDGET_CEILING_WARN_ABOVE_CEILING: 'TENANT_BUDGET_CEILING_WARN_ABOVE_CEILING',
  /** `uq_tc_tenant_currency` — this tenant already lists this `currencyCode` (T-126 TC-2). */
  TENANT_CURRENCY_EXISTS: 'TENANT_CURRENCY_EXISTS',
  /** `uq_tc_one_default` — this tenant already has an `isDefault: true` row (T-126 TC-3). */
  TENANT_CURRENCY_DEFAULT_EXISTS: 'TENANT_CURRENCY_DEFAULT_EXISTS',
});

/** 409 — `POST /tenants` with a `code` already in use (TC-10). */
export class TenantCodeExistsError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(TENANT_ERROR_CODE.TENANT_CODE_EXISTS, options);
  }
}

/** 409 — `schemaPrefix` already in use by another tenant (TC-11). */
export class TenantSchemaPrefixExistsError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(TENANT_ERROR_CODE.TENANT_SCHEMA_PREFIX_EXISTS, options);
  }
}

/** 409 — the Tenant Admin's `email` is already a live `portal_users` row. */
export class TenantAdminEmailExistsError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(TENANT_ERROR_CODE.TENANT_ADMIN_EMAIL_EXISTS, options);
  }
}

/** 409 — `POST /:id/activate` called on a tenant that is not `pending_provisioning` (TC-16). */
export class TenantAlreadyActiveError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(TENANT_ERROR_CODE.TENANT_ALREADY_ACTIVE, options);
  }
}

/**
 * 422 — a write that requires an `active` tenant found one that is not (implementation note 3:
 * "Only `active` tenants may have campaigns created against them"). `tenants.service.ts` does not
 * throw this itself (nothing in this module's own scope creates campaigns); it is exported for
 * whichever module later enforces §17's `TENANT_NOT_ACTIVE` 422 against campaign submission —
 * see `tenant-active.guard.ts`.
 */
export class TenantNotActiveError extends BusinessRuleError {
  constructor(options: AppErrorOptions = {}) {
    super(TENANT_ERROR_CODE.TENANT_NOT_ACTIVE, options);
  }
}

/** 409 — `POST /tenants/:id/currencies` with a `currencyCode` this tenant already lists
 * (T-126 TC-2 counterpart: the accept path; this is the reject path for a repeat). */
export class TenantCurrencyExistsError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(TENANT_ERROR_CODE.TENANT_CURRENCY_EXISTS, options);
  }
}

/** 409 — a second `isDefault: true` row for the same tenant (`uq_tc_one_default`, T-126 TC-3). */
export class TenantCurrencyDefaultExistsError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(TENANT_ERROR_CODE.TENANT_CURRENCY_DEFAULT_EXISTS, options);
  }
}
