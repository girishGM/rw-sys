/**
 * T-042 — the domain-specific error codes `/definition-requests` introduces, on top of the
 * generic catalogue `common/errors/app-error.ts` already provides. None of these has a
 * `system_messages` row yet — the same deviation `versions.errors.ts` (T-041) records for its
 * own new codes: seed migrations for `system_messages` are outside this module's `Files owned`.
 */
import {
  BusinessRuleError,
  ConflictError,
  ValidationFailedError,
  type AppErrorOptions,
} from '@/common/errors/app-error';
import type { DefinitionRequestStatusValue } from './definition-requests.constants';

export const DEFINITION_REQUEST_ERROR_CODE = Object.freeze({
  /** A `request_type`/`entityId` combination that does not make sense: `update_*` with no
   * `entityId`, or `new_*` with one supplied. */
  ENTITY_ID_REQUIRED: 'DEFINITION_REQUEST_ENTITY_ID_REQUIRED',
  ENTITY_ID_NOT_ALLOWED: 'DEFINITION_REQUEST_ENTITY_ID_NOT_ALLOWED',
  /** Editing/withdrawing a request that is no longer `submitted` (TC-7), or a `.../review`/
   * `.../fulfil` call that does not match the fixed state diagram (TC-12). */
  INVALID_TRANSITION: 'DEFINITION_REQUEST_INVALID_TRANSITION',
  /** `POST .../review` with `status: 'rejected'` and no `reviewComment` (TC-10). */
  REJECTION_COMMENT_REQUIRED: 'DEFINITION_REQUEST_REJECTION_COMMENT_REQUIRED',
  /** `POST .../fulfil` against a version that is not `published` (TC-14). */
  VERSION_NOT_PUBLISHED: 'DEFINITION_REQUEST_VERSION_NOT_PUBLISHED',
});

/** 400 — `entityId` is required for `update_rule`/`update_reward` and was not supplied. */
export class EntityIdRequiredError extends ValidationFailedError {
  constructor(options: AppErrorOptions = {}) {
    super([{ field: 'entityId', code: 'REQUIRED' }], {
      ...options,
      logMessage: DEFINITION_REQUEST_ERROR_CODE.ENTITY_ID_REQUIRED,
    });
  }
}

/** 400 — `entityId` must be absent for `new_rule`/`new_reward`. */
export class EntityIdNotAllowedError extends ValidationFailedError {
  constructor(options: AppErrorOptions = {}) {
    super([{ field: 'entityId', code: 'NOT_ALLOWED' }], {
      ...options,
      logMessage: DEFINITION_REQUEST_ERROR_CODE.ENTITY_ID_NOT_ALLOWED,
    });
  }
}

/** 409 — the request is not in the state the requested transition needs (TC-7, TC-12): editing
 * or withdrawing a non-`submitted` request, or a `.../review` move the state diagram forbids. */
export class DefinitionRequestInvalidTransitionError extends ConflictError {
  constructor(from: DefinitionRequestStatusValue, to: string, options: AppErrorOptions = {}) {
    super(DEFINITION_REQUEST_ERROR_CODE.INVALID_TRANSITION, {
      ...options,
      logContext: { ...options.logContext, from, to },
    });
  }
}

/** 400 — `POST .../review` with `status: 'rejected'` and no `reviewComment` (TC-10):
 * "A country whose request is refused without a reason will simply raise it again." */
export class RejectionCommentRequiredError extends ValidationFailedError {
  constructor(options: AppErrorOptions = {}) {
    super([{ field: 'reviewComment', code: 'REQUIRED' }], {
      ...options,
      logMessage: DEFINITION_REQUEST_ERROR_CODE.REJECTION_COMMENT_REQUIRED,
    });
  }
}

/** 422 — `POST .../fulfil` with a version that is not `published` (implementation note 5:
 * "Linking a draft would mark a request satisfied by something no country can use"). */
export class DefinitionRequestVersionNotPublishedError extends BusinessRuleError {
  constructor(options: AppErrorOptions = {}) {
    super(DEFINITION_REQUEST_ERROR_CODE.VERSION_NOT_PUBLISHED, options);
  }
}
