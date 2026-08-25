/**
 * T-036 — the domain-specific error codes `/merchants` introduces, on top of the generic
 * catalogue `common/errors/app-error.ts` already provides.
 *
 * None of these has a `system_messages` row yet — the same disclosed deviation
 * `tenants.errors.ts`/`countries.errors.ts` record for their own new codes: `MessageService`
 * degrades to returning the key itself, which is safe (no internal detail) but unlocalised until
 * a seed migration adds them. Seed migrations are outside this module's file scope
 * (`back-end/src/database/migrations/**`, save for the one T-046 migration this task does not
 * touch either).
 */
import { BusinessRuleError, ConflictError, ValidationFailedError } from '@/common/errors/app-error';
import type { AppErrorOptions, ErrorDetail } from '@/common/errors/app-error';

export const MERCHANT_ERROR_CODE = Object.freeze({
  /** `uq_m_tenant_code` — mapped away from the raw constraint name (TC-3; TC-4 is the sibling
   * "correctly allowed" case: two tenants may legitimately share a code). */
  MERCHANT_CODE_EXISTS: 'MERCHANT_CODE_EXISTS',
  /** 400 — `countryCode` does not match the tenant's own country (implementation note 3, TC-5). */
  MERCHANT_COUNTRY_MISMATCH: 'MERCHANT_COUNTRY_MISMATCH',
  /** `uq_ms_tenant_code` on `merchant_stores` (TC-12/TC-13's sibling conflict case). */
  MERCHANT_STORE_CODE_EXISTS: 'MERCHANT_STORE_CODE_EXISTS',
  /** 409 — a tenant-wide activity link (`storeId` omitted) already exists for this merchant and
   * activity (implementation note 4, TC-15) — service-detected, since the live unique constraint
   * does not catch two `NULL store_id` rows; or the database's own `uq_ma_merchant_activity_store`
   * fired for a duplicate non-`NULL` `storeId`. */
  MERCHANT_ACTIVITY_ALREADY_LINKED: 'MERCHANT_ACTIVITY_ALREADY_LINKED',
  /** 422 — deactivating a merchant that participates in an active campaign, without
   * `confirm: true` (implementation note 7, TC-20). */
  MERCHANT_DEACTIVATION_REQUIRES_CONFIRMATION: 'MERCHANT_DEACTIVATION_REQUIRES_CONFIRMATION',
});

/** 409 — `POST /merchants` with a `merchantCode` already in use *within the same tenant*
 * (TC-3). A different tenant reusing the same code is not this error (TC-4) — `uq_m_tenant_code`
 * is itself scoped to `(tenant_id, merchant_code)`, so the database only ever raises this for a
 * genuine same-tenant collision. */
export class MerchantCodeExistsError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(MERCHANT_ERROR_CODE.MERCHANT_CODE_EXISTS, options);
  }
}

/** 409 — `POST /merchants/:id/stores` with a `storeCode` already in use within the same tenant
 * (`uq_ms_tenant_code`). */
export class MerchantStoreCodeExistsError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(MERCHANT_ERROR_CODE.MERCHANT_STORE_CODE_EXISTS, options);
  }
}

/** 409 — see {@link MERCHANT_ERROR_CODE.MERCHANT_ACTIVITY_ALREADY_LINKED}. */
export class MerchantActivityAlreadyLinkedError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(MERCHANT_ERROR_CODE.MERCHANT_ACTIVITY_ALREADY_LINKED, options);
  }
}

/** 422 — see {@link MERCHANT_ERROR_CODE.MERCHANT_DEACTIVATION_REQUIRES_CONFIRMATION}. */
export class MerchantDeactivationRequiresConfirmationError extends BusinessRuleError {
  constructor(options: AppErrorOptions = {}) {
    super(MERCHANT_ERROR_CODE.MERCHANT_DEACTIVATION_REQUIRES_CONFIRMATION, {
      ...options,
      details: [{ field: 'confirm', code: 'REQUIRED' }],
    });
  }
}

/** 400 — `countryCode` in the request does not match the actor's tenant's own country
 * (implementation note 3, TC-5). Built from the generic {@link ValidationFailedError} rather than
 * a new class, the same precedent `users.errors.ts#targetScopeIdRequiredError` sets: 03-API-
 * CONTRACT.md §1 reserves `details` for exactly this shape. */
export function merchantCountryMismatchError(): ValidationFailedError {
  const detail: ErrorDetail = {
    field: 'countryCode',
    code: MERCHANT_ERROR_CODE.MERCHANT_COUNTRY_MISMATCH,
  };
  return new ValidationFailedError([detail]);
}
