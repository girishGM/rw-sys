/**
 * T-013 — layer 2 of 02-SECURITY.md §5: *"Has Super Admin granted this role this action?"*
 *
 * The **runtime-configurable** half. Where `@Roles` is a compile-time statement about who may
 * approach an endpoint, this is a lookup in `role_entity_permissions`, which the Access Control
 * screen (T-033) edits live. The two are independent on purpose: 02-SECURITY.md §5 opens with
 * *"Layers are independent on purpose: a mistake in one must not become an exploit."*
 *
 * ### The layer that must not be trusted alone
 *
 * A row in `role_entity_permissions` is data, and data can be wrong — edited by mistake, edited
 * maliciously by a compromised Super Admin, or restored from a bad backup. 00-ARCHITECTURE.md
 * §5.2 therefore requires a **third**, code-level assertion for the authority rules that matter:
 * even if the table grants `maker` → `rule:create`, `RuleService.create()` must still refuse
 * (T-013 TC-19). `assertRole()` is that third layer; this decorator is not a substitute for it.
 *
 * `entity` and `action` are the vocabulary of 01-DATABASE.md §5.1 — portal-level nouns
 * (`campaign`, `rule`, `access_control`, …) and the verbs seeded against them. They are typed as
 * `string` rather than a union because the table is designed to grow at runtime; the seeded set
 * is asserted by T-004's own tests and by `permission-cache.service.spec.ts`.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import { PERMISSION_METADATA_KEY } from '../rbac.constants';

export interface RequiredPermission {
  readonly entity: string;
  readonly action: string;
}

/**
 * Requires `entity:action` to be granted to the caller's role.
 *
 * Blank values are rejected at startup rather than looked up and denied at runtime: an empty
 * entity would fail every request against the route, which is safe but would be diagnosed as a
 * permission-data problem rather than as the typo it is.
 */
export const RequirePermission = (entity: string, action: string): CustomDecorator<string> => {
  if (entity.trim() === '' || action.trim() === '') {
    throw new Error('@RequirePermission() requires a non-empty entity and action.');
  }
  return SetMetadata(PERMISSION_METADATA_KEY, { entity, action } satisfies RequiredPermission);
};
