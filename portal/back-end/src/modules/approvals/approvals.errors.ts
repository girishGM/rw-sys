/**
 * T-038 — the domain-specific error codes `/approvals` introduces.
 *
 * None of these has a `system_messages` row yet — the same deviation `campaigns.errors.ts`,
 * `rules.errors.ts` and `countries.errors.ts` each record for their own new codes.
 * `MessageService` degrades to returning the key, which is safe (no internal detail) but
 * unlocalised until a seed migration adds them; seed migrations live in
 * `back-end/src/database/migrations/**`, outside this module's file scope.
 *
 * ### Why `SELF_APPROVAL_FORBIDDEN` is a 422 and not a 403
 *
 * Because the caller **does** hold the permission. A checker who submitted a campaign has every
 * authority the endpoint requires; what is refused is this particular request-and-actor pairing,
 * which is the textbook definition of *"well-formed, authorised, and forbidden by a business
 * rule"* — the sentence `BusinessRuleError`'s own doc comment uses, with self-approval as its
 * example. 03-API-CONTRACT.md §12 fixes the status and the code verbatim, so this is transcribed
 * rather than chosen.
 *
 * A 403 here would also be actively misleading in the one situation the control exists for: a
 * user who legitimately holds both maker and checker duties would read "you may not approve
 * things" and go asking for a permission they already have, instead of "somebody else must
 * approve this one".
 */
import { BusinessRuleError, ConflictError, type AppErrorOptions } from '@/common/errors/app-error';

export const APPROVAL_ERROR_CODE = Object.freeze({
  /** 422 — `requested_by === actor.id` (03-API-CONTRACT.md §12, TC-6). */
  SELF_APPROVAL_FORBIDDEN: 'SELF_APPROVAL_FORBIDDEN',
  /** 409 — the request timed out before anyone decided it (implementation note 5, TC-13). */
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  /** 409 — somebody already decided it (implementation note 6, TC-12/TC-15). */
  APPROVAL_ALREADY_DECIDED: 'APPROVAL_ALREADY_DECIDED',
  /** 409 — the request names an entity type this module has no decision path for. */
  APPROVAL_SUBJECT_UNSUPPORTED: 'APPROVAL_SUBJECT_UNSUPPORTED',
});

/**
 * 422 `SELF_APPROVAL_FORBIDDEN` — the segregation-of-duty control, and the one error in this file
 * that must never become conditional.
 *
 * Thrown by `ApprovalsService` **before** any state is read past the request row and before any
 * write, for all three decisions rather than for `approve` alone: returning or rejecting your own
 * submission is self-review too, and the maker who wants to take a submission back has
 * `POST /campaigns/:id/submit`'s own state machine for that, not the checker's queue.
 *
 * `logContext` deliberately carries only ids. Naming the user in a response body would confirm
 * account existence; naming them in the log is what an operator investigating a segregation
 * breach actually needs.
 */
export class SelfApprovalForbiddenError extends BusinessRuleError {
  constructor(requestId: number, actorId: number, options: AppErrorOptions = {}) {
    super(APPROVAL_ERROR_CODE.SELF_APPROVAL_FORBIDDEN, {
      ...options,
      logMessage:
        `Segregation of duty: user ${actorId} may not decide approval request ${requestId}, ` +
        'which they submitted themselves.',
      logContext: { ...options.logContext, requestId, actorId },
    });
  }
}

/** 409 — past `expires_at`, whether or not the sweeper has run yet (TC-13, TC-14). */
export class ApprovalExpiredError extends ConflictError {
  constructor(requestId: number, expiresAt: Date, options: AppErrorOptions = {}) {
    super(APPROVAL_ERROR_CODE.APPROVAL_EXPIRED, {
      ...options,
      logContext: { ...options.logContext, requestId, expiresAt: expiresAt.toISOString() },
    });
  }
}

/**
 * 409 — the request is no longer `pending`.
 *
 * This is what the loser of TC-15's two-checker race receives. It is raised from two independent
 * places inside the same transaction — after the `SELECT … FOR UPDATE`, and again from the
 * conditional `UPDATE … WHERE status = 'pending'` that returns zero rows — because a lock and a
 * guarded write fail in different ways and neither alone is a proof.
 */
export class ApprovalAlreadyDecidedError extends ConflictError {
  constructor(requestId: number, status: string, options: AppErrorOptions = {}) {
    super(APPROVAL_ERROR_CODE.APPROVAL_ALREADY_DECIDED, {
      ...options,
      logContext: { ...options.logContext, requestId, status },
    });
  }
}

/**
 * 409 — `entity_type` is something other than `campaign`.
 *
 * `portal_approval_requests.entity_type` is a free `varchar(50)`; today only campaign submission
 * writes it (T-037), but the table is explicitly a generic maker/checker workflow store. A row
 * this module cannot act on is refused loudly rather than approved into a no-op, which is what
 * "approved" would otherwise silently mean.
 */
export class ApprovalSubjectUnsupportedError extends ConflictError {
  constructor(entityType: string, options: AppErrorOptions = {}) {
    super(APPROVAL_ERROR_CODE.APPROVAL_SUBJECT_UNSUPPORTED, {
      ...options,
      logContext: { ...options.logContext, entityType },
    });
  }
}
