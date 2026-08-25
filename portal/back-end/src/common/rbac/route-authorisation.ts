/**
 * T-013 — reads a route's authorisation metadata, and answers the one question both guards need
 * before they can do anything else: **is this route guarded at all?**
 *
 * ### Why "unguarded" is a denial, not a default
 *
 * T-013 TC-18: *"Route with no `@Roles` and no `@Public()` → Denied + warning logged."* The
 * failure this prevents is the most common way a portal like this leaks: somebody adds
 * `GET /tenants/:id/api-keys`, forgets the decorator, and the endpoint ships open because the
 * framework's default for "no metadata" is "no restriction". Inverting that default costs one
 * branch and converts a silent vulnerability into a 403 plus a log line during the first manual
 * test of the new endpoint.
 *
 * The route-inventory test of 03-API-CONTRACT.md §15 is the second, independent check on the
 * same property — it enumerates every registered route and fails the build. Both exist because
 * a runtime denial and a build-time failure catch the mistake at different moments and neither
 * subsumes the other.
 *
 * ### Handler-then-class, as `isPublic` does
 *
 * `getAllAndOverride` returns the first defined value, so a handler-level decorator wins over a
 * controller-level one. That makes the natural shape work: `@Roles('tenant_admin')` on a
 * controller, with one handler widened to `@Roles('tenant_admin', 'maker')`.
 *
 * ### A note on where this is used
 *
 * Both `RolesGuard` and `PermissionsGuard` call {@link isRouteUnguarded} independently, and both
 * deny on it. That is duplication on purpose: 02-SECURITY.md §5's premise is that "a mistake in
 * one [layer] must not become an exploit", and a guard whose safety depends on a *different*
 * guard having run first is not independent. Removing either check must not open the route.
 */
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { PortalRole } from '@/database/portal-models';
import { PERMISSION_METADATA_KEY, ROLES_METADATA_KEY } from './rbac.constants';
import type { RequiredPermission } from './decorators/require-permission.decorator';

export interface RouteAuthorisation {
  /** From `@Roles(...)`, or `undefined` when the route carries none. */
  readonly roles: readonly PortalRole[] | undefined;
  /** From `@RequirePermission(...)`, or `undefined`. */
  readonly permission: RequiredPermission | undefined;
}

export function readRouteAuthorisation(
  reflector: Reflector,
  context: ExecutionContext,
): RouteAuthorisation {
  const targets = [context.getHandler(), context.getClass()];
  return {
    roles: reflector.getAllAndOverride<readonly PortalRole[]>(ROLES_METADATA_KEY, targets),
    permission: reflector.getAllAndOverride<RequiredPermission>(PERMISSION_METADATA_KEY, targets),
  };
}

/**
 * True when a non-`@Public()` route declares no authorisation of any kind.
 *
 * Note that `@RequirePermission` alone counts as guarded. That is the reconciliation of T-013
 * implementation note 6 ("missing metadata on a non-`@Public()` route → deny and log") with
 * TC-1 and TC-4, which expect a 200 from routes that carry `@Roles` and, in TC-1's case, no
 * `@RequirePermission`. Read literally and per-guard, note 6 would make TC-1 impossible; read as
 * the sentence it belongs to — *"so an unguarded endpoint fails rather than defaults open"* — it
 * is a statement about the route, which is what this function implements. Recorded in the T-013
 * completion report.
 */
export function isRouteUnguarded(authorisation: RouteAuthorisation): boolean {
  return authorisation.roles === undefined && authorisation.permission === undefined;
}
