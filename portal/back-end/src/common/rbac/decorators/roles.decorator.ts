/**
 * T-013 — layer 1 of 02-SECURITY.md §5: *"Is this role allowed near this endpoint at all?"*
 *
 * This is the **static** half of authorisation and it is intentionally not runtime-configurable.
 * 00-ARCHITECTURE.md §5.4 states the reasoning: the role hierarchy "is enforced by
 * `ck_portal_users_scope` … and the creation matrix hardcoded in `UserService`", not by a data
 * row, because "this logic benefits from being visible in code and covered by the type checker,
 * not editable at runtime by a misconfigured data row". `@Roles` is where that decision shows up
 * per endpoint: a Super Admin editing `role_entity_permissions` through the Access Control screen
 * can grant and revoke *actions*, but cannot put `merchant` on a route annotated
 * `@Roles('super_admin')`.
 *
 * `PortalRole[]` rather than `string[]`: a typo (`'super-admin'`) is then a compile error, not a
 * route nobody can reach.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { PortalRole } from '@/database/portal-models';
import { ROLES_METADATA_KEY } from '../rbac.constants';

/**
 * Restricts a route (or a whole controller) to the listed roles.
 *
 * Calling it with **no** roles is rejected at startup rather than treated as "everyone": an
 * empty allow-list is far more likely to be an unfinished edit than a deliberate statement, and
 * the failure mode of guessing wrong is an open endpoint.
 */
export const Roles = (...roles: readonly PortalRole[]): CustomDecorator<string> => {
  if (roles.length === 0) {
    throw new Error(
      '@Roles() requires at least one role. Use @Public() for an unauthenticated route.',
    );
  }
  return SetMetadata(ROLES_METADATA_KEY, roles);
};
