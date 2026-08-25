/**
 * T-010 — the errors the credential layer throws.
 *
 * Placed in their own file, mirroring `src/common/crypto/crypto.errors.ts`, rather than in
 * `auth.constants.ts`: these are types with behaviour and a security contract of their own,
 * and burying them among tunable numbers makes that contract easy to miss. (This file is an
 * addition to T-010's declared *Files owned* list; it collides with no other task's list —
 * T-011 owns `auth.service.ts`, `auth.controller.ts`, the guards, the DTOs and the
 * decorators. Recorded as a deviation in the completion report.)
 *
 * ---
 *
 * ### The one rule this file exists to enforce
 *
 * `InvalidCredentialsError` is thrown for **every** authentication failure — an address that
 * matches no account, a wrong password, a locked account, an account that is not active, an
 * account with no credential row at all. T-010 Implementation notes §7: *"The caller cannot
 * distinguish unknown-user from wrong-password from locked, because the type carries no
 * discriminator."*
 *
 * That is a structural guarantee, not a convention. There is deliberately:
 *
 *  - **no subclass** — so `instanceof` cannot separate the causes;
 *  - **no `code`, `reason` or `failureCode` field** — so a caller cannot branch on one, and
 *    so no operator-only `portal_login_attempts.failure_code` can ride out to the client;
 *  - **no interpolation into the message** — the message is a frozen literal, identical for
 *    every cause, and carries no email, hash or timing hint (TC-18, TC-20).
 *
 * If a future task needs to know *why* a login failed, the answer is `portal_login_attempts`
 * and `portal_audit_log`, read by an operator — not a field added here. Adding one would
 * silently reintroduce the user-enumeration oracle that the whole of `CredentialService` is
 * shaped around, and would do it in a way no existing test would catch, because the tests
 * assert on what the error *has*, and a new field is something it *has*.
 */
import type { PasswordPolicyViolation } from './services/password-policy.service';

/**
 * The single, undifferentiated authentication failure. Read this file's header before
 * changing anything about it.
 */
export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid credentials');
    this.name = 'InvalidCredentialsError';
    Error.captureStackTrace?.(this, InvalidCredentialsError);
  }
}

/**
 * Thrown when a *new* password fails the policy. Unlike {@link InvalidCredentialsError} this
 * one is deliberately specific and carries the violated rules, because the caller is already
 * authenticated (or holds a valid single-use reset token) and cannot learn anything about
 * anyone else from the answer — while a change-password form that says only "no" is a
 * usability failure that pushes users towards weaker, guessable choices.
 *
 * The violations are stable machine codes, not sentences: T-014 owns the `system_messages`
 * catalogue that turns them into user-facing text, so the wording can change per locale
 * without touching this layer. The submitted password is never attached, quoted or logged.
 */
export class PasswordPolicyError extends Error {
  readonly violations: readonly PasswordPolicyViolation[];

  constructor(violations: readonly PasswordPolicyViolation[]) {
    super('Password does not meet the password policy');
    this.name = 'PasswordPolicyError';
    this.violations = Object.freeze([...violations]);
    Error.captureStackTrace?.(this, PasswordPolicyError);
  }
}

/**
 * Thrown when a credential operation names a `portal_users.id` that has no row, or a
 * password change targets an account with no credential row to replace.
 *
 * This is an internal consistency error on an **already-authenticated** path (the caller
 * supplies a user id it got from a verified session, not from a request body), so naming the
 * id is a debugging aid rather than a disclosure. It is never thrown from
 * `authenticate()` — that path answers every failure with {@link InvalidCredentialsError},
 * including this one.
 */
export class CredentialNotFoundError extends Error {
  constructor(userId: number) {
    super(`No credential record for portal user ${userId}`);
    this.name = 'CredentialNotFoundError';
    Error.captureStackTrace?.(this, CredentialNotFoundError);
  }
}
