/**
 * T-055 — the HTTP-facing failures this feature adds, in the envelope `auth.exceptions.ts`
 * already defines (03-API-CONTRACT.md §1). Three classes, and a deliberately short list of
 * failures that reuse T-011's existing ones rather than inventing a sibling:
 *
 * | Situation | Answer | Why not something more specific |
 * |---|---|---|
 * | Wrong TOTP code, wrong or spent recovery code | `401 AUTH_INVALID_CREDENTIALS` | 02-SECURITY.md §2a says so in as many words: *"generic 401 AUTH_INVALID_CREDENTIALS (does not confirm the password was right)"*. A distinct "wrong second factor" code would tell an attacker holding a stolen pending token that the password half is already solved. |
 * | Expired, forged or absent pending token | `401 AUTH_SESSION_INVALID` | The client's only correct reaction is the same as for any dead session: start again at the login screen (TC-13). |
 * | Unknown or non-`super_admin` target of an admin reset | `404 NOT_FOUND` | 02-SECURITY.md §5.1 — "does not exist" and "you may not see it" must be indistinguishable. |
 *
 * As in `auth.exceptions.ts`, **no error here carries an internal message, an id, an email or a
 * reason**. The `code` is a `system_messages` key the SPA localises client-side.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { authErrorBody } from './auth.exceptions';
import { MFA_ERROR_CODE } from './mfa.constants';

/**
 * 403 — a `super_admin` with `mfa_enabled = false` touched a route outside the enrolment flow
 * (implementation note 5, TC-4), or tried to use somebody else's account-recovery power without
 * having a second factor of their own (note 6, TC-16).
 *
 * 403 rather than 401 for the reason `PasswordChangeRequiredHttpException` gives: the caller is
 * authenticated — or has at least proved their password — and is *confined*, not unauthenticated.
 * A 401 would send the SPA into a refresh loop that could never resolve, because there is nothing
 * wrong with the credential to fix.
 */
export class MfaEnrolmentRequiredHttpException extends HttpException {
  constructor() {
    super(authErrorBody(MFA_ERROR_CODE.ENROLMENT_REQUIRED), HttpStatus.FORBIDDEN);
  }
}

/**
 * 403 — an **enrolled** `super_admin` presented a pending token somewhere other than the four
 * routes an MFA challenge may reach. The distinction from the class above is only a matter of
 * which screen the SPA renders next: "enrol" or "enter your code".
 */
export class MfaPendingHttpException extends HttpException {
  constructor() {
    super(authErrorBody(MFA_ERROR_CODE.PENDING), HttpStatus.FORBIDDEN);
  }
}

/**
 * 403 — `POST /auth/mfa/enrol` on an account that is already enrolled (TC-2).
 *
 * The seed is shown **exactly once**, at enrolment (implementation note 2). Re-issuing it on
 * demand would turn "shown once" into "shown whenever asked", which is the whole property that
 * makes the seed's storage worth encrypting. Getting a new one requires an administrative reset
 * by another `super_admin`, which is audited.
 */
export class MfaAlreadyEnrolledHttpException extends HttpException {
  constructor() {
    super(authErrorBody(MFA_ERROR_CODE.ALREADY_ENROLLED), HttpStatus.FORBIDDEN);
  }
}
