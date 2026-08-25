/**
 * T-011 — layer one of the request chain: *is there a valid access token?*
 *
 * This guard answers exactly that and nothing more. It does not ask whether the session behind
 * the token is still alive (`SessionValidGuard`), whether the role may reach this route
 * (`RolesGuard`, T-013), or whether the row being addressed is in scope
 * (`TenancyScopeInterceptor`, T-013). Keeping the layers independent is 02-SECURITY.md §5's
 * stated design goal: *"a mistake in one must not become an exploit"*.
 *
 * ### Where the token comes from, and where it does not
 *
 * Only the `__Host-rs_at` **cookie**. There is deliberately no `Authorization: Bearer` fallback:
 *
 *  - a bearer header is readable by JavaScript by construction, which is the property
 *    02-SECURITY.md §1 spends its whole design avoiding;
 *  - accepting two transports means the CSRF story has to hold for both, and `SameSite=Strict`
 *    protects only the cookie;
 *  - a fallback is the classic way a "temporary" test affordance becomes a permanent bypass.
 *
 * If a machine-to-machine caller ever needs access, it gets its own credential type and its own
 * guard (see `grpc_service_grants`, 09-INTEGRATION.md §4c) — not a second door into this one.
 */
import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CHAIN_SPAN, traceSpan } from '@/common/tracing/span.service';
import { ACCESS_COOKIE, readCookie } from '../auth.cookies';
import { SessionInvalidHttpException } from '../auth.exceptions';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthenticatedRequest } from '../decorators/current-user.decorator';
import { InvalidAccessTokenError, TokenService } from '../services/token.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  /**
   * T-019 added the span wrapper and nothing else — the decision is unchanged, in `authenticate`.
   * `jwt.verify` is stage 2 of 08-OBSERVABILITY.md §5's waterfall; `traceSpan` is a no-op outside
   * a request. See `span.service.ts`.
   */
  canActivate(context: ExecutionContext): boolean {
    return traceSpan(CHAIN_SPAN.JWT_VERIFY, () => this.authenticate(context));
  }

  private authenticate(context: ExecutionContext): boolean {
    if (isPublic(this.reflector, context)) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readCookie(request.headers.cookie, ACCESS_COOKIE.name);

    if (token === null) throw new SessionInvalidHttpException();

    try {
      const claims = this.tokens.verifyAccessToken(token, new Date());
      // The single point at which a verified scope enters the request. R3's "from the verified
      // JWT only" is true because this assignment is the only writer of `authUser` that exists.
      request.authUser = {
        userId: claims.userId,
        sessionId: claims.sessionId,
        role: claims.role,
        countryId: claims.countryId,
        tenantId: claims.tenantId,
        merchantId: claims.merchantId,
        rbacVersion: claims.rbacVersion,
        tokenId: claims.tokenId,
        // Provisional. `SessionValidGuard` replaces it with the live value from the database;
        // `true` is the fail-closed starting point, so a chain missing that guard confines the
        // session rather than freeing it.
        mustChangePassword: true,
      };
      return true;
    } catch (error) {
      // The reason is specific in the log and absent from the response — see
      // `SessionInvalidHttpException` for why the client is told only that the session is bad.
      const reason = error instanceof InvalidAccessTokenError ? error.reason : 'unexpected';
      this.logger.debug(`Access token rejected (${reason})`);
      throw new SessionInvalidHttpException();
    }
  }
}

/**
 * Reads `@Public()` from the handler first, then the controller class.
 *
 * Handler-then-class, not the other way round: a `@Public()` controller with one authenticated
 * handler is a shape that should work, and `getAllAndOverride` returning the first defined value
 * gives the handler the last word.
 */
export function isPublic(reflector: Reflector, context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}
