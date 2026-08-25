/**
 * T-013 — position 8 of 00-ARCHITECTURE.md §6, layer 2 of 02-SECURITY.md §5.
 *
 * *Has Super Admin granted this role this action?* Answered from `role_entity_permissions`
 * through `PermissionCacheService`, which reads `rbac_version:<role>` live so a revocation takes
 * effect on the next request rather than at the end of a TTL (TC-16).
 *
 * ### Fail-closed, stated precisely (TC-17)
 *
 * Every path that is not "the permission is present in the map" denies:
 *
 *  - the route is unguarded → deny (independently of `RolesGuard`; see `route-authorisation.ts`
 *    for why the check is duplicated rather than shared);
 *  - there is no authenticated user → deny;
 *  - the cache or the database throws → deny;
 *  - the map has no entry for the entity, or the entry lacks the action → deny.
 *
 * The third deserves its own sentence. A `PermissionCacheService` that cannot reach Postgres
 * throws, and this guard converts that into a `403 PERM_DENIED` rather than letting it become a
 * 500. Two reasons: the response must not differ in shape between "you may not" and "our
 * database is unwell" (the second is an operational fact an unauthenticated prober should not be
 * able to elicit), and a 500 escaping here would be handled by whatever error filter happens to
 * be installed — which is not something an authorisation decision should depend on. The
 * exception itself is logged at `error`, so the outage is loud where it should be: in the log,
 * not in the response.
 *
 * ### What this guard is explicitly *not* sufficient for
 *
 * 00-ARCHITECTURE.md §5.2 requires the rule/reward authority rules to survive a wrong row in
 * `role_entity_permissions`. This guard reads that table, so it cannot be the thing that
 * survives it. `assertRole()` in the service layer is (TC-19).
 */
import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '@/modules/auth/decorators/current-user.decorator';
import { isPublic } from '@/modules/auth/guards/jwt-auth.guard';
import { CHAIN_SPAN, traceSpan } from '@/common/tracing/span.service';
import { PermissionCacheService } from './permission-cache.service';
import { PermissionDeniedHttpException } from './rbac.exceptions';
import { routeLabel } from './roles.guard';
import { isRouteUnguarded, readRouteAuthorisation } from './route-authorisation';

@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionCacheService,
  ) {}

  /**
   * T-019 added the span wrapper and nothing else — the decision is unchanged, in `check`.
   * `permission.check` is stage 4 of 08-OBSERVABILITY.md §5's waterfall, and the one whose
   * `(cache hit)` annotation the design doc singles out. A denial closes the span as `denied`
   * rather than `error` (see `span.service.ts`), because the chain refusing is the chain working.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    return traceSpan(CHAIN_SPAN.PERMISSION_CHECK, () => this.check(context));
  }

  private async check(context: ExecutionContext): Promise<boolean> {
    if (isPublic(this.reflector, context)) return true;
    if (context.getType() !== 'http') return true;

    const authorisation = readRouteAuthorisation(this.reflector, context);

    if (isRouteUnguarded(authorisation)) {
      this.logger.error(
        `Route ${routeLabel(context)} declares no authorisation metadata and is not @Public() ` +
          '— denying.',
      );
      throw new PermissionDeniedHttpException();
    }

    // No `@RequirePermission` on the route: there is no runtime-configurable action to check,
    // and `RolesGuard` has already established that the caller's role is admitted. Passing here
    // is what makes TC-1 (`@Roles('super_admin')` alone → 200) work; see `route-authorisation.ts`
    // for the reconciliation with implementation note 6.
    const required = authorisation.permission;
    if (required === undefined) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authUser = request.authUser;

    if (authUser === undefined) {
      this.logger.error(
        `PermissionsGuard reached ${routeLabel(context)} with no authenticated user — denying.`,
      );
      throw new PermissionDeniedHttpException();
    }

    let granted: boolean;
    try {
      granted = await this.permissions.isGranted(authUser.role, required.entity, required.action);
    } catch (error) {
      this.logger.error(
        `Permission lookup failed for ${authUser.role} on ${required.entity}:${required.action} ` +
          `— denying (fail-closed): ${(error as Error).message}`,
      );
      throw new PermissionDeniedHttpException();
    }

    if (!granted) {
      this.logger.debug(
        `Denied ${authUser.role} on ${routeLabel(context)}: ` +
          `${required.entity}:${required.action} is not granted`,
      );
      throw new PermissionDeniedHttpException();
    }

    return true;
  }
}
