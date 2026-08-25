/**
 * T-011 — layer two: *is the session behind this token still alive, and is its owner still an
 * active account?*
 *
 * ### Why a database read on every request is the right trade
 *
 * The access token is a JWT precisely so the hot path needs no lookup — and then this guard adds
 * one back. That is deliberate, and it is the single reason "deactivate this user" or "log this
 * session out" takes effect in under a second instead of in up to fifteen minutes (T-011
 * implementation note 6). Without it, every revocation in the system would be advisory until the
 * current access token expired: a compromised session would stay usable for the remainder of its
 * quarter-hour no matter what an administrator did.
 *
 * The cost is one indexed primary-key lookup joined to one indexed foreign key. The alternative
 * designs — a revocation bloom filter, a short-lived cache, pushing revocation into the token —
 * all trade correctness for a saving this application does not need at its expected volume.
 * 08-OBSERVABILITY.md's latency budget accounts for this query.
 *
 * ### Two checks, not one
 *
 * The session must be `active` and unexpired, **and** the user must be neither soft-deleted nor
 * in a non-`active` status. The second is not redundant: revoking a deactivated user's sessions
 * is the job of whatever code deactivates them (T-035), and this guard must hold even if that
 * code is wrong, is added later, or misses a session in a partial failure. A guard that depends
 * on another module having remembered something is not a guard (TC-17).
 *
 * T-013 (implementation note 9, architect review AR-10) extends the same query with the parent
 * tenant's and merchant's status, so a suspended tenant invalidates its users' sessions on their
 * next request. That belongs in `SessionRepository.findSessionContext`, which already returns a
 * row shaped to absorb it without changing this file.
 */
import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CHAIN_SPAN, traceSpan } from '@/common/tracing/span.service';
import { SessionInvalidHttpException } from '../auth.exceptions';
import type { AuthenticatedRequest } from '../decorators/current-user.decorator';
import { SessionService } from '../services/session.service';
import { isPublic } from './jwt-auth.guard';

@Injectable()
export class SessionValidGuard implements CanActivate {
  private readonly logger = new Logger(SessionValidGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  /**
   * T-019 added the span wrapper and nothing else — the decision is unchanged, in `validate`.
   * `session.validate` is stage 3 of 08-OBSERVABILITY.md §5's waterfall, and the first that
   * touches the database, which is exactly why it is worth timing separately. `traceSpan` awaits
   * the returned promise for timing only and is a no-op outside a request; see `span.service.ts`.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    return traceSpan(CHAIN_SPAN.SESSION_VALIDATE, () => this.validate(context));
  }

  private async validate(context: ExecutionContext): Promise<boolean> {
    if (isPublic(this.reflector, context)) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authUser = request.authUser;

    if (authUser === undefined) {
      // Reachable only if this guard runs on a non-public route without `JwtAuthGuard` in front
      // of it — a wiring mistake. Denying is the fail-closed reading of "I do not know who this
      // is"; allowing would turn a mis-ordered guard array into an authentication bypass.
      this.logger.warn('SessionValidGuard reached with no authenticated user — denying');
      throw new SessionInvalidHttpException();
    }

    const session = await this.sessions.resolveActive(authUser.sessionId, new Date());
    if (session === null) throw new SessionInvalidHttpException();

    if (session.userId !== authUser.userId) {
      // A validly-signed token whose `sid` names another user's session. Not producible by this
      // system; checked because the consequence of being wrong is acting as the wrong user.
      this.logger.error(
        `Session ${authUser.sessionId} belongs to user ${session.userId}, token claims ${authUser.userId}`,
      );
      throw new SessionInvalidHttpException();
    }

    // The live flag replaces the fail-closed placeholder `JwtAuthGuard` set — this is what makes
    // clearing `must_change_password` take effect on the very next request (TC-20).
    request.authUser = { ...authUser, mustChangePassword: session.mustChangePassword };

    return true;
  }
}
