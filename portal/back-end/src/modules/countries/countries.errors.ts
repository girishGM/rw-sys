/**
 * T-030 — the domain-specific error codes `/countries` introduces, on top of the generic
 * catalogue `common/errors/app-error.ts` already provides.
 *
 * None of these has a `system_messages` row yet (flagged in the completion report, the same
 * deviation `auth.exceptions.ts` records for T-011's own new codes): `MessageService` degrades to
 * returning the key itself, which is safe — no internal detail — but unlocalised until a seed
 * migration adds them. Seed migrations are outside this module's file scope
 * (`back-end/src/database/migrations/**`).
 */
import { BusinessRuleError, ConflictError, type AppErrorOptions } from '@/common/errors/app-error';

export const COUNTRY_ERROR_CODE = Object.freeze({
  /** `uq_countries_code` — mapped away from the raw constraint name (T-030 implementation note 2). */
  COUNTRY_CODE_EXISTS: 'COUNTRY_CODE_EXISTS',
  /** At most one country may carry `is_hq = true` (T-030 implementation note 4). */
  HQ_ALREADY_EXISTS: 'HQ_ALREADY_EXISTS',
  /** `uq_portal_users_email_live` on the admin being onboarded. */
  ADMIN_EMAIL_EXISTS: 'ADMIN_EMAIL_EXISTS',
  /** T-030 implementation note 7 — deactivation has active tenants and `confirm` was not sent. */
  COUNTRY_DEACTIVATION_REQUIRES_CONFIRMATION: 'COUNTRY_DEACTIVATION_REQUIRES_CONFIRMATION',
});

/** 409 — `POST /countries` with a `code` already in use (TC-2). */
export class CountryCodeExistsError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(COUNTRY_ERROR_CODE.COUNTRY_CODE_EXISTS, options);
  }
}

/** 409 — the admin's `email` is already a live `portal_users` row. */
export class AdminEmailExistsError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(COUNTRY_ERROR_CODE.ADMIN_EMAIL_EXISTS, options);
  }
}

/** 422 — `isHq: true` when another country already carries the flag (TC-5). */
export class HqAlreadyExistsError extends BusinessRuleError {
  constructor(options: AppErrorOptions = {}) {
    super(COUNTRY_ERROR_CODE.HQ_ALREADY_EXISTS, options);
  }
}

/** 422 — deactivating a country with active tenants, without `confirm: true` (TC-14). */
export class CountryDeactivationRequiresConfirmationError extends BusinessRuleError {
  constructor(options: AppErrorOptions = {}) {
    super(COUNTRY_ERROR_CODE.COUNTRY_DEACTIVATION_REQUIRES_CONFIRMATION, {
      ...options,
      details: [{ field: 'confirm', code: 'REQUIRED' }],
    });
  }
}
