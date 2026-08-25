/**
 * T-035 — the domain-specific error codes `/users` introduces, on top of the generic catalogue
 * `common/errors/app-error.ts` already provides.
 *
 * `RoleCreationNotPermittedError`, `RoleChangeNotPermittedError` and (added by T-088/F-12)
 * `RoleManagementNotPermittedError` are the three codes this module's own risk flag exists for:
 * all are 403s constructed directly from {@link AppError} with their own status, following
 * exactly the pattern `common/errors/app-error.ts`'s own `ConflictError`/`BusinessRuleError`
 * establish (`super(code, status, options)`) — there is no pre-built "ForbiddenError" export in
 * that file to extend instead (that file is `back-end/src/common/errors/**`, outside this task's
 * file scope, AGENT-PROTOCOL R9), and {@link ErrorNormalizationFilter}'s `classify()` reads
 * `exception.status`/`exception.code` directly off any {@link AppError} subclass, so this needs
 * nothing added there either.
 *
 * None of these codes has a `system_messages` row yet — the same disclosed deviation
 * `tenants.errors.ts`/`countries.errors.ts` record for their own new codes: `MessageService`
 * degrades to returning the key itself, which is safe (no internal detail) but unlocalised
 * until a seed migration adds them. Seed migrations are outside this module's file scope
 * (`back-end/src/database/migrations/**`, save for the one T-046 migration this task does not
 * touch either).
 */
import {
  AppError,
  BusinessRuleError,
  ERROR_CODE,
  ValidationFailedError,
  type AppErrorOptions,
} from '@/common/errors/app-error';

export const USER_ERROR_CODE = Object.freeze({
  /** 403 — the actor's role may not create a user of the requested role, either because the
   * creation matrix (03-API-CONTRACT.md §7) has no entry for the pair at all, or because the
   * target role is outside the actor's own scope (T-035 implementation note 1; TC-2, TC-3,
   * TC-5, TC-6, TC-8, TC-9, TC-10, TC-12 — the mandatory escalation tests). */
  ROLE_CREATION_NOT_PERMITTED: 'ROLE_CREATION_NOT_PERMITTED',
  /** 403 — `PATCH /users/:id` carried a `role` field. No role transition is permitted through
   * this route at all in v1 (TC-28's escalation case is the mandatory one, but the check refuses
   * every value, not only an escalating one — see `users.service.ts#update`'s own header). */
  ROLE_CHANGE_NOT_PERMITTED: 'ROLE_CHANGE_NOT_PERMITTED',
  /** 403 — T-088 (finding F-12): the actor's role is not permitted to act on an *existing* user
   * of the target's role at all, whether the write is `PATCH /users/:id`,
   * `POST /users/:id/deactivate` or `POST /users/:id/reset-password`. Reuses the same
   * {@link ROLE_CREATION_NOT_PERMITTED} matrix (`ALLOWED_CREATION`) rather than a laxer one — see
   * `users.service.ts#assertManagementAllowed`'s own header for why "act on" must never reach
   * further than "create" does. */
  ROLE_MANAGEMENT_NOT_PERMITTED: 'ROLE_MANAGEMENT_NOT_PERMITTED',
  /** 409 — `uq_portal_users_email_live` on the user being created. */
  USER_EMAIL_EXISTS: 'USER_EMAIL_EXISTS',
  /** 422 — `POST /users/:id/deactivate` called by the target on themselves (implementation note
   * 6, TC-23): "an admin cannot accidentally orphan a tenant." */
  CANNOT_DEACTIVATE_SELF: 'CANNOT_DEACTIVATE_SELF',
});

/** 403 — see the file header for why this extends {@link AppError} directly. */
export class RoleCreationNotPermittedError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(USER_ERROR_CODE.ROLE_CREATION_NOT_PERMITTED, 403, options);
  }
}

/** 403 — see the file header for why this extends {@link AppError} directly. */
export class RoleChangeNotPermittedError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(USER_ERROR_CODE.ROLE_CHANGE_NOT_PERMITTED, 403, options);
  }
}

/** 403 — T-088/F-12. See the file header and `users.service.ts#assertManagementAllowed`. */
export class RoleManagementNotPermittedError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(USER_ERROR_CODE.ROLE_MANAGEMENT_NOT_PERMITTED, 403, options);
  }
}

/** 409 — the new user's `email` is already a live `portal_users` row (TC-15, case-insensitive —
 * enforced by `email_bidx`, `model-encryption.hooks.ts`'s own normalisation, not by this class). */
export class UserEmailExistsError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(USER_ERROR_CODE.USER_EMAIL_EXISTS, 409, options);
  }
}

/** 422 — a user attempting to deactivate their own account (TC-23). */
export class CannotDeactivateSelfError extends BusinessRuleError {
  constructor(options: AppErrorOptions = {}) {
    super(USER_ERROR_CODE.CANNOT_DEACTIVATE_SELF, options);
  }
}

/**
 * 400 — the target role's scope requires an id (`countryId`/`tenantId`/`merchantId`) the caller
 * did not supply, or supplied for the wrong field (implementation note 2, TC-14: "the DB CHECK
 * would also reject" — this is the same requirement enforced earlier, with a machine-readable
 * `details` entry rather than a generic constraint failure). Built from the generic
 * {@link ValidationFailedError} rather than a new class: 03-API-CONTRACT.md §1 reserves `details`
 * for exactly this shape, and a fourth near-identical 400 class here would buy nothing a
 * `{ field, code }` pair does not already say.
 */
export function targetScopeIdRequiredError(field: 'countryId' | 'tenantId' | 'merchantId') {
  return new ValidationFailedError([{ field, code: 'REQUIRED' }]);
}

/**
 * 429 — T-046 implementation note 7: 20 temporary-password generations per admin per hour, on
 * both `POST /users` and `POST /users/:id/reset-password` (`TemporaryPasswordService`).
 *
 * Reuses the generic {@link ERROR_CODE.RATE_LIMITED} rather than minting a new code — this is the
 * same class of event `SECURITY_ERROR_CODE.RATE_LIMITED` (`common/security/security.exceptions.ts`,
 * T-012, outside this task's file scope) already names for the global per-route limiter; a second,
 * differently-spelled code for the same client-visible fact (`"you are being throttled"`) would
 * only give a caller a second signal to distinguish limits by, which 02-SECURITY.md §8's own "no
 * indication of which of the seven limits tripped" principle argues against.
 */
export class TemporaryPasswordRateLimitedError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(ERROR_CODE.RATE_LIMITED, 429, options);
  }
}
