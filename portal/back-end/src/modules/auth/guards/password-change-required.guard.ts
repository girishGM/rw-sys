/**
 * T-011 — layer three of this module's own chain: *this session must change its password before
 * it may do anything else.*
 *
 * A user provisioned by an administrator, or one whose password has passed
 * `password_expires_at`, holds a perfectly valid session that is confined to exactly two
 * endpoints — `/auth/change-password` and `/auth/logout` — until the password is changed
 * (02-SECURITY.md §2, T-011 implementation note 7).
 *
 * **This is a guard, not front-end routing.** 02-SECURITY.md §2 says so in as many words. A SPA
 * that redirects to a change-password screen is a courtesy; the thing that stops a provisioned
 * account with a temporary password from calling `POST /campaigns` directly is this file.
 *
 * The answer is **403 with `PASSWORD_CHANGE_REQUIRED`**, not 401. The caller is authenticated —
 * their session is fine, it is simply restricted. A 401 would send the SPA into a refresh loop
 * that could never resolve, because there is nothing wrong with the token to fix.
 */
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PasswordChangeRequiredHttpException } from '../auth.exceptions';
import type { AuthenticatedRequest } from '../decorators/current-user.decorator';
import { PASSWORD_CHANGE_EXEMPT_KEY } from '../decorators/password-change-exempt.decorator';
import { isPublic } from './jwt-auth.guard';

@Injectable()
export class PasswordChangeRequiredGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (isPublic(this.reflector, context)) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authUser = request.authUser;

    // No authenticated user means the guards in front of this one have already decided the
    // request's fate; there is no password-change state to enforce. This branch never *grants*
    // access on its own — `JwtAuthGuard` and `SessionValidGuard` have both already run.
    if (authUser === undefined) return true;

    if (!authUser.mustChangePassword) return true;

    const exempt =
      this.reflector.getAllAndOverride<boolean>(PASSWORD_CHANGE_EXEMPT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true;

    if (exempt) return true;

    throw new PasswordChangeRequiredHttpException();
  }
}
