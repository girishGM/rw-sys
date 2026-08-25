/**
 * T-051 test support — the **authorisation** view of the route inventory, and the pure function
 * that turns it into a role × endpoint matrix.
 *
 * ### How this differs from `route-inventory.ts` next door
 *
 * T-012's collector answers "what routes exist, and what are their handlers called" — enough for
 * its mutating-`@Get()` heuristic. This one additionally reads the three pieces of metadata the
 * guard chain actually decides on (`@Public()`, `@Roles()`, `@RequirePermission()`), because
 * T-051's TC-1 and TC-2 are about the *decision*, not the route list. It reuses
 * {@link collectRoutes}'s traversal rather than forking it: one place knows how to walk
 * `ModulesContainer`, and if that ever breaks, both checks break loudly together instead of one
 * silently returning an empty list and passing.
 *
 * ### Handler-then-class, exactly as the guards resolve it
 *
 * `RolesGuard`/`PermissionsGuard` read metadata through `Reflector.getAllAndOverride(key,
 * [handler, class])` — a handler-level decorator wins over a controller-level one. This module
 * reproduces that precedence in {@link readMetadata} rather than approximating it, because an
 * inventory that resolved precedence differently from the guards would describe a system nobody
 * is running. `MfaController` is the live example: `@Public()` sits on the class and applies to
 * all three of its handlers.
 *
 * ### The matrix function is here, not in the spec
 *
 * {@link expectedOutcome} is the whole of TC-2's expectation in one place: given a route's
 * authorisation metadata and the live permission grants for a role, does the guard chain admit
 * or refuse? It is a pure function so `role-matrix.spec.ts` can exercise its branches without a
 * database, and `role-matrix.e2e-spec.ts` can feed it the *real* metadata and the *real*
 * `role_entity_permissions` rows and then check the prediction against what the running server
 * actually returns. That split is deliberate: a matrix that only ever compared the code against
 * itself would be a change-detector (AGENT-PROTOCOL §3), so the e2e half asserts the observable
 * HTTP status, and this half is what makes the expectation auditable.
 */
import type { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '@/modules/auth/decorators/public.decorator';
import { PERMISSION_METADATA_KEY, ROLES_METADATA_KEY } from '@/common/rbac/rbac.constants';
import type { RequiredPermission } from '@/common/rbac/decorators/require-permission.decorator';
import type { PortalRole } from '@/database/portal-models';
import { collectRoutes, type RouteEntry } from './route-inventory';

/** The six roles of 00-ARCHITECTURE.md §2, in delegation order. */
export const ALL_ROLES: readonly PortalRole[] = [
  'super_admin',
  'country_admin',
  'tenant_admin',
  'maker',
  'checker',
  'merchant',
];

/** A route plus everything the guard chain reads before it decides. */
export interface GuardedRoute extends RouteEntry {
  readonly isPublic: boolean;
  readonly roles: readonly PortalRole[] | undefined;
  readonly permission: RequiredPermission | undefined;
  /** `GET /api/v1/auth/login` — the form 03-API-CONTRACT.md §15 writes, for comparison. */
  readonly signature: string;
}

/** `entity → actions` for one role, as `role_entity_permissions` holds it. */
export type PermissionGrants = ReadonlyMap<string, ReadonlySet<string>>;

/** What the guard chain does with one (route, role) cell. */
export type CellOutcome =
  /** `RolesGuard` or `PermissionsGuard` refuses: 403 `PERM_DENIED`. */
  | 'denied'
  /** Both guards pass; the handler (and the scope interceptor) decide what happens next. */
  | 'admitted'
  /** `@Public()`: no session needed, so the role is not a meaningful input. */
  | 'public';

/** The global prefix `main.ts` sets. §15's list is written with it, so comparisons need it. */
export const API_PREFIX = '/api/v1';

/**
 * 03-API-CONTRACT.md §15's public list, **verbatim**, as the contract states it.
 *
 * Reproduced here as data rather than paraphrased, because TC-1 is "the public list matches §15
 * exactly" and the only way to check that is to hold the document's own list. Divergences between
 * this and the running application are findings for the report, not values to be edited until the
 * test goes green — see `route-inventory.e2e-spec.ts`, which names each one.
 */
export const CONTRACT_PUBLIC_ROUTES: readonly string[] = [
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/forgot-password',
  'POST /api/v1/auth/reset-password',
  'GET /api/v1/health',
  'GET /api/v1/health/ready',
];

/** `getAllAndOverride`'s precedence — handler first, then the controller class. */
function readMetadata<T>(key: string, handler: unknown, controller: unknown): T | undefined {
  const fromHandler = Reflect.getMetadata(key, handler as object) as T | undefined;
  if (fromHandler !== undefined) return fromHandler;
  return Reflect.getMetadata(key, controller as object) as T | undefined;
}

/**
 * Normalises a collected path into §15's `METHOD /api/v1/path` form.
 *
 * Nest's metadata gives `/health/` for `@Controller('health') @Get()` and `/auth/login` for
 * `@Controller('auth') @Get('login')`; the trailing slash is an artefact of concatenation, not a
 * different route, so it is dropped before comparison. The root path stays `/`.
 */
export function signatureOf(method: string, path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return `${method} ${API_PREFIX}${trimmed}`;
}

/** Every route in a built application, with the metadata the guards read. */
export function collectGuardedRoutes(app: INestApplication): GuardedRoute[] {
  const controllersByName = new Map<string, unknown>();
  const prototypesByName = new Map<string, Record<string, unknown>>();

  // `collectRoutes` returns names rather than the classes themselves, so the classes are indexed
  // once here to resolve metadata against. Walking the container twice is cheap and keeps the
  // T-012 helper's signature untouched — it is a done task's file.
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype;
      if (typeof controller !== 'function') continue;
      controllersByName.set(controller.name, controller);
      prototypesByName.set(controller.name, controller.prototype as Record<string, unknown>);
    }
  }

  return collectRoutes(app).map((route) => {
    const controller = controllersByName.get(route.controller);
    const handler = prototypesByName.get(route.controller)?.[route.handler];

    return {
      ...route,
      isPublic: readMetadata<boolean>(IS_PUBLIC_KEY, handler, controller) === true,
      roles: readMetadata<readonly PortalRole[]>(ROLES_METADATA_KEY, handler, controller),
      permission: readMetadata<RequiredPermission>(PERMISSION_METADATA_KEY, handler, controller),
      signature: signatureOf(route.method, route.path),
    };
  });
}

/**
 * True when a non-public route carries no authorisation metadata at all.
 *
 * Mirrors `isRouteUnguarded` in `src/common/rbac/route-authorisation.ts` — deliberately a second,
 * independent statement of the same rule rather than an import of it. This is the build-time twin
 * of a runtime denial (that file's own header says so); if the runtime definition were ever
 * loosened, an inventory that imported it would loosen silently and in lockstep.
 */
export function isUnguarded(route: GuardedRoute): boolean {
  return !route.isPublic && route.roles === undefined && route.permission === undefined;
}

/**
 * What the chain does with one cell — the whole of TC-2's expectation.
 *
 * The order of the checks is the order 00-ARCHITECTURE.md §6 composes the guards in, because the
 * *reason* for a denial matters to the report even though the response is identical either way:
 *
 *  1. `@Public()` → nothing to decide (`JwtAuthGuard` short-circuits).
 *  2. no metadata at all → denied (`RolesGuard`, TC-18).
 *  3. `@Roles` present and the role is absent from it → denied (layer 1).
 *  4. `@RequirePermission` present and the grant is missing → denied (layer 2).
 *  5. otherwise admitted.
 *
 * Note what step 3 does **not** do: a route carrying only `@RequirePermission` has no role list,
 * so layer 1 passes it and layer 2 decides alone. That is the real behaviour (`RolesGuard` returns
 * true when `authorisation.roles === undefined`), and reproducing it here rather than assuming
 * both layers always apply is what lets the e2e half's predictions match reality — and what makes
 * finding F-2 in the report visible instead of averaged away.
 */
export function expectedOutcome(
  route: GuardedRoute,
  role: PortalRole,
  grants: PermissionGrants,
): CellOutcome {
  if (route.isPublic) return 'public';
  if (isUnguarded(route)) return 'denied';
  if (route.roles !== undefined && !route.roles.includes(role)) return 'denied';

  const required = route.permission;
  if (required === undefined) return 'admitted';

  return grants.get(required.entity)?.has(required.action) === true ? 'admitted' : 'denied';
}

/** Splits an inventory into the four classes §11's checklist asks about. */
export interface InventoryClassification {
  readonly publicRoutes: readonly GuardedRoute[];
  /** Carries `@Roles` (with or without `@RequirePermission`). */
  readonly roleGuarded: readonly GuardedRoute[];
  /** Carries `@RequirePermission` only — guarded by layer 2 alone. See finding F-2. */
  readonly permissionOnly: readonly GuardedRoute[];
  /** Carries nothing. Must always be empty. */
  readonly unguarded: readonly GuardedRoute[];
}

export function classify(routes: readonly GuardedRoute[]): InventoryClassification {
  return {
    publicRoutes: routes.filter((route) => route.isPublic),
    roleGuarded: routes.filter((route) => !route.isPublic && route.roles !== undefined),
    permissionOnly: routes.filter(
      (route) => !route.isPublic && route.roles === undefined && route.permission !== undefined,
    ),
    unguarded: routes.filter(isUnguarded),
  };
}

/** Reads `role_entity_permissions` into the shape {@link expectedOutcome} consumes. */
export function grantsFromRows(
  rows: readonly { role: string; entity: string; actions: unknown }[],
  role: PortalRole,
): PermissionGrants {
  const grants = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.role !== role) continue;
    // `actions` is `character varying` holding a JSON array; the driver hands it back as a string
    // unless something has already parsed it. Both are accepted rather than assumed.
    const actions: unknown =
      typeof row.actions === 'string' ? JSON.parse(row.actions) : row.actions;
    if (!Array.isArray(actions)) continue;
    grants.set(row.entity, new Set(actions.map(String)));
  }
  return grants;
}
