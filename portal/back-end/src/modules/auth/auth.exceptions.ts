/**
 * T-011 — the HTTP-facing failures of the auth module.
 *
 * ### Why these exist alongside `auth.errors.ts`
 *
 * T-010's `auth.errors.ts` holds *domain* errors — `InvalidCredentialsError`,
 * `PasswordPolicyError` — which know nothing about HTTP and are thrown by services that are
 * unit-tested without a request in sight. The classes here are their transport counterparts:
 * they carry the status code and the `system_messages` key that 03-API-CONTRACT.md §1 says a
 * response body may contain, and nothing else.
 *
 * ### Why the body is built here rather than left to T-014
 *
 * T-014 owns `ErrorNormalisationFilter`, which will eventually shape *every* error in the
 * system into the `{ error: { code, message, details, traceId } }` envelope. It has not landed
 * yet, and T-011 cannot ship endpoints whose 401 body is whatever Nest's default happens to
 * be — TC-6 requires four different login failures to produce a byte-identical body, which is
 * a property of this module, not of a filter that may or may not be installed. So each class
 * below hands Nest a response object already in the documented envelope shape. When T-014's
 * filter arrives it will recognise these as `HttpException`s carrying a well-formed body and
 * pass the code through; the `message` and `traceId` fields it adds are additive.
 *
 * **No error in this file carries an internal message, an email, an id or a reason.** The
 * `code` is a catalogue key the SPA localises client-side; that indirection is what stops an
 * internal detail from ever reaching a browser (T004_004's own doc comment).
 *
 * This file is an addition to T-011's declared *Files owned* list, mirroring the precedent
 * T-010 set with `auth.errors.ts` and `credential.repository.ts`. Recorded as a deviation in
 * the completion report.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { AUTH_ERROR_CODE } from './session.constants';

/** One entry of the `details` array — validation failures only (03-API-CONTRACT.md §1). */
export interface AuthErrorDetail {
  readonly field: string;
  readonly code: string;
}

export interface AuthErrorBody {
  readonly error: {
    readonly code: string;
    readonly details?: readonly AuthErrorDetail[];
  };
}

/** Builds the documented envelope. Exported so tests can assert against one definition. */
export function authErrorBody(code: string, details?: readonly AuthErrorDetail[]): AuthErrorBody {
  return details === undefined ? { error: { code } } : { error: { code, details } };
}

/**
 * 401 for **every** login failure — unknown address, wrong password, locked, inactive, no
 * credential row (T-011 TC-6).
 *
 * Constructed with no arguments on purpose. `InvalidCredentialsError` in `auth.errors.ts`
 * refuses to carry a discriminator so that a caller cannot branch on one; this class refuses
 * to accept one so that a caller cannot leak one. The two together are why the response is
 * identical for all four causes rather than identical-by-convention.
 */
export class InvalidCredentialsHttpException extends HttpException {
  constructor() {
    super(authErrorBody(AUTH_ERROR_CODE.INVALID_CREDENTIALS), HttpStatus.UNAUTHORIZED);
  }
}

/**
 * 401 for anything wrong with the *session*: no cookie, an expired or malformed token, a bad
 * signature, a revoked session, a deactivated user, a replayed refresh token.
 *
 * Also deliberately undifferentiated. The SPA's only correct reaction to any of these is the
 * same — try a refresh, and on failure send the user to the login screen — so a finer
 * taxonomy would buy the client nothing while telling an attacker probing with forged tokens
 * exactly which part of the check they have got past. The precise cause is logged server-side
 * by the guard that raised it.
 */
export class SessionInvalidHttpException extends HttpException {
  constructor() {
    super(authErrorBody(AUTH_ERROR_CODE.SESSION_INVALID), HttpStatus.UNAUTHORIZED);
  }
}

/**
 * 403 when `must_change_password` is set and the requested route is not one of the two the
 * flag permits (T-011 implementation note 7, TC-19).
 *
 * 403 rather than 401 because the caller *is* authenticated — the session is perfectly valid,
 * it is simply confined. A 401 would send the SPA into a refresh loop that could never
 * succeed.
 */
export class PasswordChangeRequiredHttpException extends HttpException {
  constructor() {
    super(authErrorBody(AUTH_ERROR_CODE.PASSWORD_CHANGE_REQUIRED), HttpStatus.FORBIDDEN);
  }
}

/**
 * 400 when a *new* password fails the policy, carrying the machine-readable violations.
 *
 * The asymmetry with {@link InvalidCredentialsHttpException} is deliberate and is argued in
 * full in `password-policy.service.ts`: the caller already holds a session or a validated
 * single-use reset token, so they can learn nothing about anyone else from a specific answer,
 * while a form that says only "no" trains users towards weaker passwords.
 */
export class PasswordPolicyHttpException extends HttpException {
  constructor(violations: readonly string[]) {
    super(
      authErrorBody(
        AUTH_ERROR_CODE.PASSWORD_POLICY,
        violations.map((code) => ({ field: 'newPassword', code })),
      ),
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * 400 for a reset token that is unknown, already consumed, or expired (TC-22, TC-23).
 *
 * One code for all three, for the same reason login has one: distinguishing "this token never
 * existed" from "this token was already used" tells an attacker holding a stolen link whether
 * the victim has already acted on it.
 */
export class ResetTokenInvalidHttpException extends HttpException {
  constructor() {
    super(authErrorBody(AUTH_ERROR_CODE.RESET_TOKEN_INVALID), HttpStatus.BAD_REQUEST);
  }
}

/**
 * 404 for a resource that either does not exist or is outside the caller's scope — the two
 * are deliberately indistinguishable (02-SECURITY.md §5.1). Used by
 * `DELETE /auth/sessions/:id` when the session belongs to somebody else (TC-25): a 403 there
 * would confirm that the id names a real session.
 */
export class NotFoundHttpException extends HttpException {
  constructor() {
    super(authErrorBody(AUTH_ERROR_CODE.NOT_FOUND), HttpStatus.NOT_FOUND);
  }
}
