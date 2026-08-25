/**
 * T-033 — the domain-specific error codes `/admin/access-control` introduces, on top of the
 * generic catalogue `common/errors/app-error.ts` already provides. Same discipline
 * `rules.errors.ts`/`countries.errors.ts` record: none of these has a `system_messages` row yet
 * (seed migrations are outside this module's file scope, `back-end/src/database/migrations/**`);
 * `MessageService` degrades to returning the key itself, which is safe but unlocalised.
 */
import { BusinessRuleError, ConflictError } from '@/common/errors/app-error';

export const ACCESS_CONTROL_ERROR_CODE = Object.freeze({
  /** 422 — a write would strip `super_admin`'s own access to the screen that could undo it
   * (implementation note 2, TC-11/TC-12). The single most important guard in this task. */
  CANNOT_LOCK_OUT_SUPER_ADMIN: 'CANNOT_LOCK_OUT_SUPER_ADMIN',
  /** 422 — `rule`/`reward` create/update/delete granted to a role other than `super_admin`
   * (implementation note 3, TC-13/TC-14). */
  PROTECTED_PERMISSION: 'PROTECTED_PERMISSION',
  /** 409 — the role's config changed since the caller's `GET` (TC-22). */
  ACCESS_CONTROL_VERSION_CONFLICT: 'ACCESS_CONTROL_VERSION_CONFLICT',
});

/** 422 — see {@link ACCESS_CONTROL_ERROR_CODE.CANNOT_LOCK_OUT_SUPER_ADMIN}. `details` names the
 * specific cell(s) the request would have stripped, each as `{ field, code }` so no free text
 * reaches the response (the same pattern `rules.errors.ts`'s header documents at length). */
export class CannotLockOutSuperAdminError extends BusinessRuleError {
  constructor(reasons: readonly string[]) {
    super(ACCESS_CONTROL_ERROR_CODE.CANNOT_LOCK_OUT_SUPER_ADMIN, {
      details: reasons.map((reason) => ({ field: 'role', code: reason })),
      logContext: { reasons },
    });
  }
}

/** 422 — see {@link ACCESS_CONTROL_ERROR_CODE.PROTECTED_PERMISSION}. */
export class ProtectedPermissionError extends BusinessRuleError {
  constructor(cells: readonly { entity: string; action: string }[]) {
    super(ACCESS_CONTROL_ERROR_CODE.PROTECTED_PERMISSION, {
      details: cells.map((cell) => ({
        field: 'permissions',
        code: `${cell.entity}_${cell.action}`.toUpperCase(),
      })),
      logContext: { cells },
    });
  }
}

/** 409 — see {@link ACCESS_CONTROL_ERROR_CODE.ACCESS_CONTROL_VERSION_CONFLICT}. */
export class AccessControlVersionConflictError extends ConflictError {
  constructor(expected: number, actual: number) {
    super(ACCESS_CONTROL_ERROR_CODE.ACCESS_CONTROL_VERSION_CONFLICT, {
      logContext: { expected, actual },
    });
  }
}

// A `{ entity, action }` pair that is not in `ENTITY_ACTION_CATALOGUE` (TC-23) is rejected as a
// 400 `VALIDATION_FAILED` by `PutPermissionsDto`'s `@IsPermissionsMatrix()` before it ever reaches
// the service — the same DTO-layer pattern `dto/rule-validators.decorators.ts#IsRuleParameters`
// uses for TC-14's "specific message" requirement. There is deliberately no second,
// service-layer error class for the same check: one validation path per rule, not two that could
// drift apart on what "invalid" means.
