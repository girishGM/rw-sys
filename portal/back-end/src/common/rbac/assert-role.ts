/**
 * T-013 implementation note 7 — the third enforcement layer, and the only one that is not data.
 *
 * ### The scenario this exists for
 *
 * 00-ARCHITECTURE.md §5.2 names Super Admin as the **only** role that may author Rules and
 * Rewards, and requires three independent layers to enforce it. Two of them —
 * `@RequirePermission('rule','create')` and `role_entity_permissions` — read the same table, so
 * they are one layer wearing two hats the moment that table is wrong:
 *
 * ```sql
 * UPDATE role_entity_permissions SET actions = '["view","create"]'
 *  WHERE role = 'maker' AND entity = 'rule';
 * ```
 *
 * One row, and `maker` can author global rules for every country. That edit is reachable through
 * the Access Control screen (T-033), through a restored backup, or through a compromised Super
 * Admin session. T-013 TC-19 is exactly this: *"`maker` granted `rule:create` by editing the DB,
 * then calls `POST /rules` → **403** — service-layer assertion overrides the table."*
 *
 * `assertRole` is that override. It consults nothing: no cache, no table, no metadata. The
 * allowed roles are an argument at the call site, so the rule is visible in the service being
 * read and is checked by the type system.
 *
 * ### How Wave 3 must use it
 *
 * At the **top of the service method**, not in the controller:
 *
 * ```ts
 * async create(actor: AuthenticatedUser, dto: CreateRuleDto): Promise<Rule> {
 *   assertRole(actor, 'super_admin');   // ← independent of role_entity_permissions
 *   …
 * }
 * ```
 *
 * In the controller it would be a fourth copy of the guard layer, bypassed by any other caller
 * of the service — the AI agent backend (T-048), a future CLI, a queue consumer. In the service
 * it holds for all of them.
 *
 * T-031 and T-032 are required by their own task files to call it; T-033's `access_control`
 * writes and T-041's blast operations should too.
 */
import { Logger } from '@nestjs/common';
import type { PortalRole } from '@/database/portal-models';
import { PermissionDeniedHttpException } from './rbac.exceptions';

const logger = new Logger('assertRole');

/** The minimum an actor must look like. Satisfied by `AuthenticatedUser`. */
export interface RoleBearingActor {
  readonly userId: number;
  readonly role: PortalRole;
}

/**
 * Throws `403 PERM_DENIED` unless the actor holds one of `allowed`.
 *
 * Returns `void` rather than a boolean on purpose: a boolean invites `if (assertRole(...))`,
 * which is a check that can be forgotten at one call site out of ten. A throwing assertion
 * cannot be used incorrectly and still compile to something that proceeds.
 */
export function assertRole(actor: RoleBearingActor, ...allowed: readonly PortalRole[]): void {
  if (allowed.length === 0) {
    // An empty allow-list would deny everyone, which is safe but is certainly a mistake — and a
    // mistake that would present as "this endpoint is broken for Super Admin too". Fail with the
    // real reason instead.
    throw new Error('assertRole() requires at least one allowed role.');
  }

  if (allowed.includes(actor.role)) return;

  // `warn`, not `debug`: reaching a hard service-layer assertion means the two guard layers in
  // front of it both let the request through, which either is a misconfigured permission row —
  // the exact scenario this function exists for — or a caller that bypassed the HTTP chain
  // entirely. Both are worth an operator's attention.
  logger.warn(
    `Service-layer role assertion failed: user ${actor.userId} holds "${actor.role}", ` +
      `requires one of [${allowed.join(', ')}]. If the permission table grants this, the table is wrong.`,
  );
  throw new PermissionDeniedHttpException();
}
