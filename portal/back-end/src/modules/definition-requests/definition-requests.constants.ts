/**
 * T-042 — constants shared by the DTOs, `DefinitionRequestsService` and its tests.
 *
 * ### Why every route here carries `@RequirePermission`, unlike `versions/**`/`blasts/**`
 *
 * Unlike `version`/`blast` (`versions.constants.ts`'s header — no seed row exists for either),
 * `definition_request` **is** a real `role_entity_permissions` entity, seeded by this task's own
 * migration (`T042_001_seed_definition_request_permissions.ts`, outside this module's `Files
 * owned` but following the task-id-prefixed-migration convention `05-EXECUTION-PLAN.md §3`
 * establishes — `RulesModule`'s `T004_001` seed predates this table, so this task adds its own
 * row rather than editing that file). `maker`, `checker` and `merchant` get no row at all
 * (implementation note 8), so `@RequirePermission(DEFINITION_REQUEST_ENTITY, …)` alone already
 * refuses them with `403 PERM_DENIED` — the same layer-1 story `rules.controller.ts` documents.
 *
 * `assertRole()` still runs at the top of every mutating method in `definition-requests.service.ts`
 * — layer 2, independent of what the permission table says (`assert-role.ts`'s own instruction:
 * *"T-013 TC-19 is exactly this: `maker` granted `rule:create` by editing the DB ... service-layer
 * assertion overrides the table"* — the same reasoning applies here even though this task is not
 * named in that file's header, because every Wave 3 mutating service in this codebase applies it).
 * `ScopedRepository`'s `DefinitionRequest` scope-strategy entry (`scope-strategy.ts`, T-013,
 * added in advance for this task: *"A request is visible to the country or tenant that raised it
 * (T-042)"*) is layer 3 — a `country_admin`/`tenant_admin` cannot read or write another scope's
 * request no matter what the guards do, because `forcedWriteValues` overwrites
 * `requestingCountryId`/`requestingTenantId` on every `create()` regardless of what this
 * service's `values` argument contains (TC-2).
 */

/** `role_entity_permissions.entity` for this module's own seed row. */
export const DEFINITION_REQUEST_ENTITY = 'definition_request';

export const DEFAULT_PAGE_SIZE = 20;
/** 03-API-CONTRACT.md §1 — "`pageSize` capped at 100". */
export const MAX_PAGE_SIZE = 100;

/** `definition_requests.request_type` — `ck_dr_type`. */
export const DEFINITION_REQUEST_TYPES = [
  'new_rule',
  'update_rule',
  'new_reward',
  'update_reward',
] as const;
export type DefinitionRequestTypeValue = (typeof DEFINITION_REQUEST_TYPES)[number];

/** `definition_requests.status` — `ck_dr_status`. */
export const DEFINITION_REQUEST_STATUSES = [
  'submitted',
  'under_review',
  'approved',
  'rejected',
  'fulfilled',
  'withdrawn',
] as const;
export type DefinitionRequestStatusValue = (typeof DEFINITION_REQUEST_STATUSES)[number];

/** `definition_requests.priority` — `ck_dr_priority`. */
export const DEFINITION_REQUEST_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type DefinitionRequestPriorityValue = (typeof DEFINITION_REQUEST_PRIORITIES)[number];

/**
 * `POST .../review`'s legal targets, keyed by the request's *current* status
 * (06-VERSIONING.md §9's state diagram, transcribed exactly):
 *
 * ```
 * submitted → under_review → approved → fulfilled
 *      │            │            │
 *      │            └──────► rejected
 *      └──────► withdrawn
 * ```
 *
 * `fulfilled` is reached only via `POST .../fulfil` (never `.../review`, TC-12: `submitted` →
 * `fulfilled` directly is illegal), and `withdrawn` only via `POST .../withdraw`. Anything not
 * listed as a value here is a `409 DEFINITION_REQUEST_INVALID_TRANSITION`.
 */
export const DEFINITION_REQUEST_REVIEW_TRANSITIONS: Readonly<
  Record<DefinitionRequestStatusValue, readonly DefinitionRequestStatusValue[]>
> = Object.freeze({
  submitted: ['under_review'],
  under_review: ['approved', 'rejected'],
  approved: [],
  rejected: [],
  fulfilled: [],
  withdrawn: [],
});

/** The subset of {@link DEFINITION_REQUEST_STATUSES} `POST .../review` may move a request to —
 * `submitted` and `withdrawn`/`fulfilled` are reached by other endpoints, never this one. */
export const DEFINITION_REQUEST_REVIEW_TARGET_STATUSES = [
  'under_review',
  'approved',
  'rejected',
] as const;
export type DefinitionRequestReviewTargetStatusValue =
  (typeof DEFINITION_REQUEST_REVIEW_TARGET_STATUSES)[number];

export const TITLE_MAX_LENGTH = 200;
export const DESCRIPTION_MIN_LENGTH = 10;
export const BUSINESS_JUSTIFICATION_MAX_LENGTH = 2000;
export const REVIEW_COMMENT_MAX_LENGTH = 1000;
