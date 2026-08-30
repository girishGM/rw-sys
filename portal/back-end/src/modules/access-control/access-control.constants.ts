/**
 * T-033 — `/admin/access-control`, the Super Admin screen that governs what every role can see
 * and do (03-API-CONTRACT.md §4, 01-DATABASE.md §5.1-§5.3).
 *
 * This file is the frozen vocabulary the service, the controller and the DTOs all read from —
 * the entity/action catalogue, the six protected `rule`/`reward` authoring cells, and the three
 * lock-out rules the task file calls "the most important rule in this task". Keeping them in one
 * place is what lets `access-control.service.ts` implement the guard structurally (checking
 * against these constants) rather than by scattering the same three literals across several
 * branches that could drift apart.
 */
import type { PortalRole } from '@/database/portal-models';

/** The permission entity this whole module governs writes to (`role_entity_permissions` row,
 * `role_nav_configs`' `access_control` nav key). Also the `@RequirePermission` entity name for
 * every route below. */
export const ACCESS_CONTROL_ENTITY = 'access_control';

/**
 * The grantable entity → action catalogue, from 01-DATABASE.md §5.1's seed table, unioned across
 * every role's row (the table a Super Admin edits is a single matrix; the *catalogue* of legal
 * cells is every action any role has ever been seeded with for that entity). `PUT
 * /permissions/:role` validates every `{ entity, action }` pair in its body against this map —
 * TC-23: "Invalid entity or action name in a PUT → 400 against the entity catalogue".
 *
 * `grpc_grant` is included deliberately: this catalogue describes the *portal-level permission
 * entity* `role_entity_permissions` already seeds it as (01-DATABASE.md §5.1, added 2026-08-14
 * AR-09), which is a wholly different thing from the two files this task must never touch
 * (`grpc-grants.controller.ts`/`.service.ts`, T-047's own CRUD administration surface for
 * `grpc_service_grants`). Access Control administers *who may reach* that surface; it does not
 * reach into it itself.
 *
 * `definition_request` — added by T-042 (out of 01-DATABASE.md §5.1's original table, which
 * predates `definition_requests`, T-005), the same reasoning `grpc_grant`'s own paragraph gives:
 * `T042_001_seed_definition_request_permissions.ts` seeds `role_entity_permissions` rows for it,
 * so it must be in this catalogue too or `PUT /permissions/:role` would 400 (TC-23) the moment a
 * Super Admin tried to adjust one of those very rows through this screen.
 *
 * `campaign`'s `pause`/`resume` — added by T-062 (2026-08-21). `T047_003_campaign_pause_permissions.ts`
 * (T-047) grants `tenant_admin` these two actions directly against `role_entity_permissions`, and
 * `campaigns.controller.ts` checks them with `@RequirePermission(CAMPAIGN_ENTITY, 'pause'|'resume')`
 * — both real, in-effect actions, not a hypothetical addition. This catalogue not knowing about
 * them was the actual cause of T-062: `PUT /admin/access-control/permissions/:role` is a **full
 * replace** (implementation note 5), so the SPA always resubmits the role's entire current
 * permission matrix, not just the cell the operator touched. The moment `tenant_admin` legitimately
 * held `campaign: ['view', 'pause', 'resume']`, *every* permissions save for that role — including
 * an ordinary, unrelated checkbox toggle — carried `pause`/`resume` back to the server and
 * `isPermissionsMatrix` rejected the whole payload as an unknown `{entity, action}` pair, 400,
 * before any diff was ever computed. Keeping this catalogue exhaustive over every action any
 * `@RequirePermission` call site or seed migration actually grants — not just the ones a screen
 * happens to have been built against first — is what TC-23/TC-24's "against the entity catalogue"
 * framing assumes; T-047 added a new grantable action without updating the one file that assumption
 * depends on, which is the general shape of this bug, not one specific to `pause`/`resume` itself.
 */
export const ENTITY_ACTION_CATALOGUE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  country: Object.freeze(['view', 'create', 'update']),
  tenant: Object.freeze(['view', 'create', 'update']),
  user: Object.freeze(['view', 'create', 'update', 'delete']),
  merchant: Object.freeze(['view', 'create', 'update']),
  rule: Object.freeze(['view', 'create', 'update', 'delete']),
  reward: Object.freeze(['view', 'create', 'update', 'delete']),
  tenant_budget_ceiling: Object.freeze(['view', 'create', 'update']),
  rule_assignment: Object.freeze(['view', 'create', 'delete']),
  reward_assignment: Object.freeze(['view', 'create', 'delete']),
  campaign: Object.freeze([
    'view',
    'create',
    'update',
    'submit',
    'approve',
    'reject',
    'return',
    'pause',
    'resume',
  ]),
  approval: Object.freeze(['view', 'approve', 'reject']),
  [ACCESS_CONTROL_ENTITY]: Object.freeze(['view', 'create', 'update', 'delete']),
  grpc_grant: Object.freeze(['view', 'create', 'update']),
  audit: Object.freeze(['view']),
  notification: Object.freeze(['view', 'update']),
  definition_request: Object.freeze(['view', 'create', 'update', 'withdraw', 'review', 'fulfil']),
  // T-140 (2026-08-30): 7 entities seeded by later migrations without this catalogue ever being
  // extended for them — the same "a seed migration grants a new {entity, action} and this map
  // isn't updated" shape T-062 already fixed once for `campaign` pause/resume (see that entry's
  // own paragraph above). `isPermissionsMatrix` validates every `PUT /permissions/:role` body
  // against this map, and that PUT is a full replace (implementation note 5), so an unlisted
  // entity does not just reject a hand-built payload — it 400s the SPA's own ordinary resave of a
  // role that legitimately holds one of these grants (every role does, at least `view`), and any
  // save that *is* accepted silently drops that role's rows for the missing entity entirely.
  // `super_admin` gets `view/create/update` (no `delete` — each seed migration deliberately
  // doesn't add one, "retire via status, never remove the row"); every other role gets `view`
  // only. Matches `T106_001`/`T116_002`/`T121_002`/`T126_002` exactly — see
  // `access-control.constants.spec.ts`'s "covers every {entity, action} any seed migration
  // actually grants" test, which now spreads all four migrations' exported permission rows.
  rule_category: Object.freeze(['view', 'create', 'update']),
  rule_sub_category: Object.freeze(['view', 'create', 'update']),
  reward_category: Object.freeze(['view', 'create', 'update']),
  reward_sub_category: Object.freeze(['view', 'create', 'update']),
  field_context_provider: Object.freeze(['view', 'create', 'update']),
  field_api_lookup_provider: Object.freeze(['view', 'create', 'update']),
  tenant_currency: Object.freeze(['view', 'create', 'update']),
});

/** Every grantable entity name — for the `GET /entities` catalogue and DTO validation. */
export const GRANTABLE_ENTITIES: readonly string[] = Object.freeze(
  Object.keys(ENTITY_ACTION_CATALOGUE),
);

/**
 * The role name the "cannot lock yourself out" rule protects. Spelled out as a constant rather
 * than the string literal `'super_admin'` at each call site, so a reviewer can grep one name to
 * find every place the rule is enforced.
 */
export const SUPER_ADMIN_ROLE: PortalRole = 'super_admin';

/** `role_nav_configs.nav_key` for the Access Control screen itself (01-DATABASE.md §5.2). */
export const ACCESS_CONTROL_NAV_KEY = 'access_control';

/**
 * The `access_control` actions `super_admin` may never lose (implementation note 2, bullet 1;
 * TC-11). Losing `view` OR `update` is enough to strand the account — `view` alone could not
 * render the screen it would need to restore anything, `update` alone could not save a fix.
 */
export const REQUIRED_SUPER_ADMIN_ACCESS_CONTROL_ACTIONS: readonly string[] = Object.freeze([
  'view',
  'update',
]);

/** Implementation note 2, bullet 3 — the one non-`access_control` cell the lock-out rule also
 * protects: without it, no account could ever provision a *replacement* Super Admin. */
export const LOCKOUT_PROTECTED_USER_CREATE = Object.freeze({ entity: 'user', action: 'create' });

/**
 * The six `rule`/`reward` authoring cells that are not grantable to any role but `super_admin`
 * (implementation note 3, TC-13/TC-14) — the same product rule T-031/T-032 enforce independently
 * with `assertRole('super_admin')`. Keeping the Access Control screen from *appearing* to
 * contradict that rule is this constant's entire purpose: nothing here weakens T-031/T-032's own
 * three layers, which hold regardless of what this table says.
 */
export const PROTECTED_PERMISSIONS: readonly { entity: string; action: string }[] = Object.freeze([
  Object.freeze({ entity: 'rule', action: 'create' }),
  Object.freeze({ entity: 'rule', action: 'update' }),
  Object.freeze({ entity: 'rule', action: 'delete' }),
  Object.freeze({ entity: 'reward', action: 'create' }),
  Object.freeze({ entity: 'reward', action: 'update' }),
  Object.freeze({ entity: 'reward', action: 'delete' }),
]);

/** `true` when `{entity, action}` is one of {@link PROTECTED_PERMISSIONS}. */
export function isProtectedPermission(entity: string, action: string): boolean {
  return PROTECTED_PERMISSIONS.some((cell) => cell.entity === entity && cell.action === action);
}

/** Every role except `super_admin` — the roles a protected permission may never be granted to. */
export const NON_SUPER_ADMIN_ROLES: readonly PortalRole[] = Object.freeze([
  'country_admin',
  'tenant_admin',
  'maker',
  'checker',
  'merchant',
]);
