/**
 * T-051 test support — **the inventory of layer 1's second sanctioned expression.**
 *
 * ## Why this exists (added on the fourth pass, 2026-08-23)
 *
 * 02-SECURITY.md §11 item 2 requires *"no endpoint lacking `@Roles` or an explicit, reviewed
 * `@Public()`"*. 103 of the application's 174 routes carry `@RequirePermission` and **no**
 * `@Roles`, and the third pass of this audit ticked item 2 anyway, on the grounds that those
 * routes express layer 1 in the service instead — `assertRole(actor, 'super_admin')` at the top of
 * `CountriesService.create`, and its equivalents. That argument is sound, and `route-inventory`
 * proves the *decorator* half of it mechanically.
 *
 * The service half was proved by **grep**, and by sending a valid body to three of the 103 routes.
 * The third pass wrote that limit down honestly:
 *
 * > *"A route whose service forgot its `assertRole` would not have been caught by the sweep,
 * > because an empty-body probe cannot reach the service layer at all."*
 *
 * This module closes that gap the same way `route-inventory.ts` closes the decorator one: by
 * enumerating the population from the running router and resolving, for **every** layer-2-only
 * mutating route, whether the service method its handler calls states a role floor. It found
 * finding **F-12** (filed as **T-088**) on its first run — three `/users` writes with no floor in either place, one of
 * which is a working privilege escalation (see `layer-two-exposure.e2e-spec.ts`).
 *
 * **Fixed by T-088** (2026-08-23): `UsersService` gained `assertManagementAllowed`, the same
 * `ALLOWED_CREATION` matrix reused for `update`/`deactivate`/`resetPassword`. `FLOOR_CALL` below
 * was extended to recognise it, and the three `/users` entries were removed from
 * `layer-two-exposure.e2e-spec.ts`'s `REVIEWED_UNFLOORED` map — this inventory now reports zero
 * unfloored mutating routes outside the two legitimately self-scoped `/notifications` ones.
 *
 * ## How the resolution works, and where it deliberately refuses to guess
 *
 * Controllers in this codebase are thin by convention ("read the request, call the service, shape
 * the response" — `countries.controller.ts`'s own header), so a handler body's `this.x.y(...)`
 * calls resolve to a service method through the constructor's `private readonly x: XService`
 * declaration. From there:
 *
 *  1. the target method's body is checked for a floor call ({@link FLOOR_CALL});
 *  2. failing that, its own `this.z(...)` calls are followed **within the same class**, to a small
 *     depth — `ApprovalsService.approve` is a one-line delegation to a private `decide()` that
 *     carries the floor, and an analyser that could not see through that would report three false
 *     positives and teach its readers to ignore it.
 *
 * **Anything it cannot resolve is reported as `unresolved`, never as floored.** That asymmetry is
 * the whole point: a source analyser that silently answers "fine" when its parser loses the thread
 * is a change-detector for its own regexes. The spec treats `unresolved` as a failure, so the day
 * this stops understanding the code is the day it says so, loudly, instead of going quietly green.
 *
 * ## What this is not
 *
 * It is a **source** analysis, and AGENT-PROTOCOL §3 is rightly suspicious of those: it can tell
 * you the call is written, not that it runs. It is paired with, and subordinate to, the behavioural
 * probe in `layer-two-exposure.e2e-spec.ts`, which grants a real role a real permission and looks
 * at the database. The division of labour is deliberate — the probe proves the property on the
 * routes it can construct a valid body for; this proves the *population* has no unexamined members.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { GuardedRoute } from './route-guard-inventory';

/** `src/`, resolved from this file rather than from `process.cwd()`, which jest does not fix. */
const SRC_ROOT = path.resolve(__dirname, '../../../src');

/**
 * The calls that constitute a role floor.
 *
 * `assertRole` is T-013 implementation note 7's third layer. `assertCreationAllowed` is
 * `users.service.ts`'s hardcoded role-creation matrix, which answers the same question ("is this
 * actor's *role* allowed to do this at all?") without consulting `role_entity_permissions`, and so
 * counts. `assertManagementAllowed` (added by T-088, fixing finding F-12) is the same matrix
 * again, reused as the floor for *acting on* an existing user rather than creating a new one —
 * `users.service.ts`'s own header, "T-088 / finding F-12", explains why it deliberately shares
 * `ALLOWED_CREATION` rather than defining a second, looser table. Deliberately a short, explicit
 * list rather than a loose `/assert\w*Role/` — a floor that this audit has not read is not a
 * floor it should credit.
 */
const FLOOR_CALL = /\bassertRole\s*\(|\bassertCreationAllowed\s*\(|\bassertManagementAllowed\s*\(/;

/** Verbs that change state. A `@Get` route cannot escalate by writing. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** How far a same-class delegation chain is followed before giving up and saying so. */
const MAX_DELEGATION_DEPTH = 4;

export interface FloorResolution {
  readonly signature: string;
  readonly controller: string;
  readonly handler: string;
  /** `'CountriesService.create'` — the method whose body carries the floor, or `undefined`. */
  readonly floor: string | undefined;
  /** Set when the analyser could not follow the code. Never conflated with "no floor". */
  readonly unresolved: string | undefined;
}

interface SourceFile {
  readonly file: string;
  readonly text: string;
}

let classIndex: Map<string, SourceFile> | undefined;

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) out.push(full);
  }
}

/** `class name → source`, built once. Duplicate class names would make resolution ambiguous. */
function indexClasses(): Map<string, SourceFile> {
  if (classIndex !== undefined) return classIndex;

  const files: string[] = [];
  walk(SRC_ROOT, files);

  const index = new Map<string, SourceFile>();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/export class (\w+)/g)) {
      index.set(match[1], { file, text });
    }
  }
  classIndex = index;
  return index;
}

/**
 * The body of `name`, braces balanced, or `undefined`.
 *
 * The subtlety that cost a debugging round: the `{` that opens the body is **not** the first `{`
 * after the signature. `async markRead(...): Promise<DataEnvelope<{ id: string }>> {` has one
 * inside the return type. So the scan tracks parenthesis and angle-bracket depth and only accepts
 * a `{` seen at depth zero.
 */
export function methodBody(source: string, name: string): string | undefined {
  const signature = new RegExp(
    `\\n  (?:public |private |protected )?(?:static )?(?:async )?${name}\\s*[(<]`,
  );
  const match = signature.exec(source);
  if (match === null) return undefined;

  let index = match.index + match[0].length - 1;
  let parens = 0;
  let angles = 0;
  for (; index < source.length; index++) {
    const char = source[index];
    if (char === '(') parens++;
    else if (char === ')') parens--;
    else if (char === '<') angles++;
    else if (char === '>') angles--;
    else if (char === '{' && parens === 0 && angles <= 0) break;
  }
  if (index >= source.length) return undefined;

  const start = index;
  let braces = 0;
  for (; index < source.length; index++) {
    if (source[index] === '{') braces++;
    else if (source[index] === '}') {
      braces--;
      if (braces === 0) return source.slice(start, index + 1);
    }
  }
  return undefined;
}

/** `private readonly countries: CountriesService` → `countries → CountriesService`. */
function injectedTypes(source: string): Map<string, string> {
  const types = new Map<string, string>();
  for (const match of source.matchAll(
    /(?:private|public|protected|readonly)\s+(?:readonly\s+)?(\w+):\s*(\w+)/g,
  )) {
    types.set(match[1], match[2]);
  }
  return types;
}

/** Does `Class.method`, or anything it delegates to inside `Class`, state a floor? */
function floorWithin(
  className: string,
  methodName: string,
  depth: number,
  seen: Set<string>,
): { floor: string | undefined; unresolved: string | undefined } {
  const key = `${className}.${methodName}`;
  if (seen.has(key)) return { floor: undefined, unresolved: undefined };
  seen.add(key);

  const target = indexClasses().get(className);
  if (target === undefined) return { floor: undefined, unresolved: `class ${className} not found` };

  const body = methodBody(target.text, methodName);
  if (body === undefined) return { floor: undefined, unresolved: `${key} body not found` };

  if (FLOOR_CALL.test(body)) return { floor: key, unresolved: undefined };
  if (depth >= MAX_DELEGATION_DEPTH) return { floor: undefined, unresolved: undefined };

  // Same-class delegation only. Following `this.someOtherService.x()` from here would drift into
  // shared helpers whose floor (if any) belongs to a different route's story.
  for (const call of body.matchAll(/this\.(\w+)\s*\(/g)) {
    const nested = floorWithin(className, call[1], depth + 1, seen);
    if (nested.floor !== undefined) return nested;
  }
  return { floor: undefined, unresolved: undefined };
}

/**
 * Resolves one route's role floor.
 *
 * Exported for the unit spec, which drives it against hand-written sources so its branches are
 * exercised without booting the application.
 */
export function resolveFloor(route: GuardedRoute): FloorResolution {
  const base = { signature: route.signature, controller: route.controller, handler: route.handler };

  const controller = indexClasses().get(route.controller);
  if (controller === undefined) {
    return { ...base, floor: undefined, unresolved: `controller ${route.controller} not found` };
  }

  const body = methodBody(controller.text, route.handler);
  if (body === undefined) {
    return {
      ...base,
      floor: undefined,
      unresolved: `${route.controller}.${route.handler} body not found`,
    };
  }

  const types = injectedTypes(controller.text);
  const calls = [...body.matchAll(/this\.(\w+)\.(\w+)\s*\(/g)];
  if (calls.length === 0) {
    return {
      ...base,
      floor: undefined,
      unresolved: `${route.controller}.${route.handler} calls no service method`,
    };
  }

  const unresolved: string[] = [];
  for (const call of calls) {
    const className = types.get(call[1]);
    if (className === undefined) {
      unresolved.push(`${route.controller}.${call[1]} has no declared type`);
      continue;
    }
    const found = floorWithin(className, call[2], 0, new Set());
    if (found.floor !== undefined) return { ...base, floor: found.floor, unresolved: undefined };
    if (found.unresolved !== undefined) unresolved.push(found.unresolved);
  }

  return {
    ...base,
    floor: undefined,
    unresolved: unresolved.length > 0 ? unresolved.join('; ') : undefined,
  };
}

/** The population item 2 is really about: mutating, non-public, `@RequirePermission` but no `@Roles`. */
export function layerTwoOnlyMutating(routes: readonly GuardedRoute[]): GuardedRoute[] {
  return routes.filter(
    (route) =>
      !route.isPublic &&
      route.roles === undefined &&
      route.permission !== undefined &&
      MUTATING_METHODS.has(route.method),
  );
}

/** {@link resolveFloor} over {@link layerTwoOnlyMutating}, deduplicated by signature. */
export function resolveRoleFloors(routes: readonly GuardedRoute[]): FloorResolution[] {
  const bySignature = new Map<string, FloorResolution>();
  for (const route of layerTwoOnlyMutating(routes)) {
    if (!bySignature.has(route.signature)) bySignature.set(route.signature, resolveFloor(route));
  }
  return [...bySignature.values()].sort((a, b) => a.signature.localeCompare(b.signature));
}
