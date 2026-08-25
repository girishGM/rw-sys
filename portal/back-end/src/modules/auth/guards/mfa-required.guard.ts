/**
 * T-055 — the two guards that make "MFA is mandatory for `super_admin`" a property of the request
 * chain rather than a setting a user can decline (implementation note 5).
 *
 * ```
 *  ...
 *  4  CsrfGuard                     SecurityModule  (T-012)
 *  4b MfaPendingConfinementGuard    ← this file      "you are halfway through a login"
 *  5  JwtAuthGuard                  AuthModule      (T-011)
 *  6  SessionValidGuard             AuthModule      (T-011)
 *  6b PasswordChangeRequiredGuard   AuthModule      (T-011)
 *  6c MfaRequiredGuard              ← this file      "your session has no second factor behind it"
 *  7  RolesGuard                    RbacModule      (T-013)
 *  ...
 * ```
 *
 * Two guards rather than one because the two states they answer for are genuinely different, and
 * a single guard could not sit in a position that catches both:
 *
 *  - a caller **with a pending token and no session** is not authenticated at all, so anything
 *    after `JwtAuthGuard` never sees them — `JwtAuthGuard` answers 401 first. Catching them needs
 *    a position *before* authentication (4b);
 *  - a caller **with a real session** whose account is not enrolled is authenticated, and the
 *    check needs `request.authUser`, which only exists *after* authentication (6c).
 *
 * ### Neither guard ever grants anything
 *
 * This is the property that makes putting one of them in front of `JwtAuthGuard` safe. Both are
 * deny-only: they return `true` (meaning "I have nothing to say") or they throw. Neither writes
 * `request.authUser`, neither reads a role from anything but the verified token, and removing
 * either one cannot open a route that was closed — it can only lose a clearer error code. Compare
 * `request-identity.ts`, which makes the same argument for T-012's pre-authentication token read.
 */
import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { readCookie } from '../auth.cookies';
import type { AuthenticatedRequest } from '../decorators/current-user.decorator';
import { MFA_EXEMPT_KEY } from '../decorators/mfa-exempt.decorator';
import { MFA_PENDING_COOKIE } from '../mfa.constants';
import { MfaEnrolmentRequiredHttpException, MfaPendingHttpException } from '../mfa.exceptions';
import { MFA_STORE, type MfaStore } from '../services/mfa.repository';
import { MfaPendingTokenService } from '../services/mfa-pending-token.service';
import { MFA_MANDATORY_ROLE } from '../services/totp-step-up.hook';
import { isPublic } from './jwt-auth.guard';

/**
 * **4b — the half-authenticated caller.**
 *
 * A `super_admin` who has passed the password step holds `__Host-rs_mfa` and nothing else. On the
 * four exempt routes that is exactly the credential they need; anywhere else it is worth a clear
 * 403 rather than the bare 401 an absent session cookie would produce — the SPA can then render
 * "finish enrolling" or "enter your code" instead of bouncing the user back to a login form they
 * have already completed (TC-4, verification step 4).
 *
 * **The 403 is a courtesy, not a control.** The control is that no session exists: without one,
 * every route in the application is already closed by `JwtAuthGuard`. This guard cannot open
 * anything, and if it were deleted the only change would be the status code an unenrolled
 * `super_admin` sees on a route they cannot reach either way.
 *
 * A token that is expired, forged or malformed is treated as *absent* — this guard says nothing
 * and the chain behind it answers 401. Answering 403 for an unverifiable string would let anyone
 * put arbitrary bytes in a cookie and change another endpoint's status code.
 */
@Injectable()
export class MfaPendingConfinementGuard implements CanActivate {
  private readonly logger = new Logger(MfaPendingConfinementGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly pendingTokens: MfaPendingTokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Non-HTTP transports (T-047's gRPC port) carry no cookies and live outside this chain, the
    // same exclusion `RolesGuard` makes.
    if (context.getType() !== 'http') return true;
    if (isMfaExempt(this.reflector, context)) return true;
    // `@Public()` routes — login, refresh, forgot/reset password, health — stay reachable. A
    // half-authenticated caller must always be able to start again; confining them out of the
    // login endpoint would be a lockout, not a control.
    if (isPublic(this.reflector, context)) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const presented = readCookie(request.headers.cookie, MFA_PENDING_COOKIE.name);
    if (presented === null) return true;

    const claims = this.pendingTokens.verify(presented);
    if (claims === null) return true;

    this.logger.debug(
      `Confined MFA-pending user ${claims.userId} (enrolled=${claims.enrolled}) on a non-exempt route`,
    );

    // The distinction is only about which screen the SPA shows next; both are 403, and neither
    // reveals anything the holder of this token does not already know about their own account.
    throw claims.enrolled ? new MfaPendingHttpException() : new MfaEnrolmentRequiredHttpException();
  }
}

/**
 * **6c — the authenticated `super_admin` with no second factor.**
 *
 * Mirrors `PasswordChangeRequiredGuard` exactly, as implementation note 5 requires: same
 * position in the chain, same 403-not-401 reasoning, same exempt-route mechanism. It is the
 * guarantee behind 02-SECURITY.md §11's checklist item — *"a fresh `super_admin` account cannot
 * reach any route beyond `/auth/*` and `/auth/mfa/enrol` until `mfa_enabled = true`"*.
 *
 * ### Why it re-reads the database instead of trusting the token
 *
 * `mfa_enabled` is deliberately **not** a JWT claim, for the reason `must_change_password` is
 * not one: a value cached in a 15-minute token would leave an administrative reset unenforced for
 * up to a quarter of an hour, on the one action in this feature that exists to be used in an
 * emergency. The cost is one indexed primary-key read, and only for `super_admin` requests —
 * every other role returns two lines above it, so five sixths of the traffic never touches the
 * database here at all.
 *
 * ### Which sessions this actually catches
 *
 * In a system that has only ever run T-055's login path, none: `TotpStepUpHook` denies a session
 * to every `super_admin` until a challenge is satisfied, so an unenrolled one cannot have a
 * session to bring here. It catches the cases that make it worth having anyway — sessions that
 * already existed when this feature was deployed, sessions surviving an administrative reset
 * mid-flight, and any future code path that creates a session without going through the login
 * flow. A guard whose safety depends on another component having remembered something is not a
 * guard (the argument `session-valid.guard.ts` makes about deactivated users).
 */
@Injectable()
export class MfaRequiredGuard implements CanActivate {
  private readonly logger = new Logger(MfaRequiredGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(MFA_STORE) private readonly mfa: MfaStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isPublic(this.reflector, context)) return true;
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authUser = request.authUser;

    // No authenticated user means the guards in front of this one have already decided the
    // request's fate. This branch never *grants* access on its own — `JwtAuthGuard` and
    // `SessionValidGuard` have both already run. (Identical to `PasswordChangeRequiredGuard`.)
    if (authUser === undefined) return true;

    // The role comes from the verified JWT and from nowhere else (R3).
    if (authUser.role !== MFA_MANDATORY_ROLE) return true;
    if (isMfaExempt(this.reflector, context)) return true;

    const enabled = await this.mfa.isMfaEnabled(authUser.userId);
    if (enabled === true) return true;

    // `false` (not enrolled) and `null` (the row has vanished under a live session) both deny.
    // Fail closed: "I could not confirm this account has a second factor" is not permission.
    this.logger.warn(
      `super_admin ${authUser.userId} reached a protected route with mfa_enabled=${String(enabled)} — denying`,
    );
    throw new MfaEnrolmentRequiredHttpException();
  }
}

/**
 * Reads `@AllowWhileMfaPending()` from the handler first, then the controller class — the same
 * handler-then-class precedence `isPublic` uses, and for the same reason.
 */
export function isMfaExempt(reflector: Reflector, context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean>(MFA_EXEMPT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}
