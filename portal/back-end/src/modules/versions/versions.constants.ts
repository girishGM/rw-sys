/**
 * T-041 — constants shared by the DTOs, the two version services and their tests.
 *
 * ### Why there is no `role_entity_permissions` entity for "version"
 *
 * `T004_001_seed_role_entity_permissions.ts` (out of this task's `Files owned`) seeds no
 * `version`/`blast` row — those tables did not exist when that seed was written (T-005 landed
 * after it). Every write route in this module is therefore gated by `@Roles('super_admin')`
 * alone, the same precedent `rewards.controller.ts` already establishes for `reward_policy`/
 * `reward_policy_cap` (*"not a weaker check than `@RequirePermission`, just the one that
 * matches what this sub-resource actually needs: a static role gate, since there is no
 * `role_entity_permissions` row a Super Admin could ever hand to another role for it"*). Read
 * routes reuse the existing `rule`/`reward` `view` permission (`RULE_ENTITY`/`REWARD_ENTITY`,
 * already granted to every non-merchant role) — a version's visibility is *defined* as
 * following its rule/reward's own visibility (06-VERSIONING.md §4.1, `scope-strategy.ts`'s
 * `RuleVersion`/`RewardVersion` entries: *"A version follows its rule's visibility"*), so
 * reusing that entity for the permission check is not a shortcut, it is the same authority
 * question asked twice on purpose (layer 1 + `ScopedRepository`'s scope layer).
 *
 * `assertRole(actor, 'super_admin')` still runs at the top of every mutating service method
 * below — layer 2, independent of `@Roles`, per `assert-role.ts`'s own instruction: *"T-041's
 * blast operations should too."* Applied here to every version write for the same reason
 * T-031/T-032 apply it to every rule/reward write: a static `@Roles` decorator is still just
 * metadata a route could lose in a refactor; the service-layer assertion cannot be bypassed by
 * forgetting a decorator.
 */

export const DEFAULT_PAGE_SIZE = 20;
/** 03-API-CONTRACT.md §1 — "`pageSize` capped at 100". */
export const MAX_PAGE_SIZE = 100;

export const CHANGE_SUMMARY_MAX_LENGTH = 500;
export const RULE_EXPRESSION_MAX_LENGTH = 8000;

/** `rule_versions.status` / `reward_versions.status` — `ck_rv_status` (06-VERSIONING.md §5). */
export const VERSION_STATUSES = ['draft', 'published', 'deprecated', 'retired'] as const;
export type VersionStatusValue = (typeof VERSION_STATUSES)[number];

/** `rule_version_country_assignments.status` / the reward mirror — `ck_rvca_status`. */
export const ASSIGNMENT_STATUSES = ['active', 'superseded', 'withdrawn'] as const;
export type AssignmentStatusValue = (typeof ASSIGNMENT_STATUSES)[number];

/**
 * `tenant_campaigns.status` values this module treats as "an active campaign" for the
 * withdraw-in-use check (implementation note 7). Same narrowing `rules/campaign-usage.query.ts`
 * documents at length for its own `ACTIVE_CAMPAIGN_STATUSES`, and for the same reason: T-037
 * (campaign wizard) had not shipped at the time this was written.
 */
export const ACTIVE_CAMPAIGN_STATUSES = ['active'] as const;
