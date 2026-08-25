/**
 * T-013 — position 7 of 00-ARCHITECTURE.md §6, layer 1 of 02-SECURITY.md §5.
 *
 * *Is this role allowed near this endpoint at all?* Nothing more. It does not know what the
 * request is trying to do (`PermissionsGuard`), or which rows it is trying to reach
 * (`TenancyScopeInterceptor`). Keeping it that narrow is what lets each layer be read and
 * reviewed on its own.
 *
 * Three denials, in this order, and each is a different bug being caught:
 *
 * | Condition | Why it denies |
 * |---|---|
 * | no `authUser` on a non-public route | the chain is mis-ordered or `JwtAuthGuard` is missing — a wiring bug that must not be an authentication bypass |
 * | the route declares no authorisation at all | TC-18: an endpoint shipped without a decorator fails rather than defaults open |
 * | the role is not in `@Roles(...)` | the ordinary case (TC-2) |
 *
 * All three produce the same `403 PERM_DENIED` with no detail (TC-3). The distinction lives in
 * the server log, at three different levels, because the three mean very different things to an
 * operator: `error` for a mis-ordered chain, `error` for an unguarded route, `debug` for a user
 * who simply may not.
 */
import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '@/modules/auth/decorators/current-user.decorator';
import { isPublic } from '@/modules/auth/guards/jwt-auth.guard';
import { PermissionDeniedHttpException } from './rbac.exceptions';
import { isRouteUnguarded, readRouteAuthorisation } from './route-authorisation';

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (isPublic(this.reflector, context)) return true;

    // Non-HTTP transports (T-047's gRPC port, 03-API-CONTRACT.md §16b's mTLS callback) live
    // outside this chain by design and carry `MtlsGuard`/`ServiceScopeGuard` instead. Denying
    // them here would break them; passing them through does not weaken anything, because this
    // guard has nothing to say about a caller with no portal role.
    if (context.getType() !== 'http') return true;

    const authorisation = readRouteAuthorisation(this.reflector, context);

    if (isRouteUnguarded(authorisation)) {
      // TC-18. `error`, not `warn`: an endpoint with no authorisation metadata is a shipped
      // vulnerability that happens to have been caught, and it should be impossible to miss in
      // a log. 03-API-CONTRACT.md §15's route-inventory test is the build-time twin of this.
      this.logger.error(
        `Route ${routeLabel(context)} declares neither @Roles() nor @RequirePermission() ` +
          'and is not @Public() — denying. Add the missing decorator.',
      );
      throw new PermissionDeniedHttpException();
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authUser = request.authUser;

    if (authUser === undefined) {
      this.logger.error(
        `RolesGuard reached ${routeLabel(context)} with no authenticated user — denying. ` +
          'JwtAuthGuard must run before this guard (00-ARCHITECTURE.md §6).',
      );
      throw new PermissionDeniedHttpException();
    }

    // A route carrying only `@RequirePermission` is guarded by layer 2 alone; there is no role
    // list for this layer to check, so it passes and `PermissionsGuard` decides.
    if (authorisation.roles === undefined) return true;

    if (!authorisation.roles.includes(authUser.role)) {
      this.logger.debug(
        `Denied ${authUser.role} on ${routeLabel(context)} (allowed: ${authorisation.roles.join(', ')})`,
      );
      throw new PermissionDeniedHttpException();
    }

    return true;
  }
}

/** `Controller.handler` — for the log only; never reaches a response. */
export function routeLabel(context: ExecutionContext): string {
  return `${context.getClass().name}.${context.getHandler().name}`;
}
