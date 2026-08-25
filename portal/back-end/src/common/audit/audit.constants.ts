/**
 * T-014 — the vocabulary of both audit stores.
 *
 * ### Two stores, strictly separated (implementation note 1, 01-DATABASE.md §2.5)
 *
 * > *"Authentication and access-control events go to `portal_audit_log`. Campaign/domain changes
 * > go to the existing `reward_config.campaign_audit_trail` … Agents must not duplicate domain
 * > events into the portal log."*
 *
 * The separation is enforced by types, not by convention: a domain event must name one of
 * {@link CAMPAIGN_AUDIT_ACTION} and one of {@link CAMPAIGN_AUDIT_ENTITY_TYPE}, and those two
 * unions are transcribed from the live `CHECK` constraints — so writing a campaign event to the
 * portal log, or inventing an action the database will reject, is a compile error rather than a
 * runtime insert failure discovered in production.
 *
 * ### Why the error codes are duplicated here rather than imported
 *
 * `recordRequestFailure` maps a response code to a portal event. Importing
 * `PERMISSION_DENIED_CODE` from `common/rbac`, `AUTH_ERROR_CODE` from `modules/auth` and
 * `SECURITY_ERROR_CODE` from `common/security` would make `common/audit` — a leaf that the error
 * filter, every Wave 3 module and eventually the gRPC port all depend on — transitively import
 * three feature modules and their database dependencies. The literals are duplicated instead,
 * and `audit.constants.spec.ts` asserts each one is identical to its source constant, so the
 * duplication cannot silently drift.
 */

/**
 * The `portal_audit_log.event_type` values **this task** writes. `varchar(60)`.
 *
 * T-011 owns the successful-authentication side of the catalogue (`AUTH_AUDIT_EVENT` in
 * `session.constants.ts`: `login_succeeded`, `logout`, `refresh_reuse_detected`, …) and writes
 * those rows itself, because it must be able to audit a request that never reaches a controller.
 * The three below are the *failure* side, which only the exception filter can see.
 */
export const PORTAL_AUDIT_EVENT = Object.freeze({
  /** A rejected sign-in. TC-2. Never carries the submitted password — see `audit.service.ts`. */
  LOGIN_FAILURE: 'login_failure',
  /** `RolesGuard` or `PermissionsGuard` refused the request. TC-3. */
  PERMISSION_DENIED: 'permission_denied',
  /** A mutating request with a missing or mismatched double-submit token (T-012). */
  CSRF_REJECTED: 'csrf_rejected',
});

/**
 * Response codes that mean "audit this failure", and the event each maps to.
 *
 * Anything not listed produces **no** audit row. That is deliberate: a 404 or a 400 on a
 * public endpoint is not a security event, and a log that records every mistyped URL is a log
 * nobody reads. Keys are duplicated literals of codes owned elsewhere — see the file header.
 */
export const FAILURE_EVENT_BY_CODE: Readonly<Record<string, string>> = Object.freeze({
  /** `AUTH_ERROR_CODE.INVALID_CREDENTIALS` (`modules/auth/session.constants.ts`). */
  AUTH_INVALID_CREDENTIALS: PORTAL_AUDIT_EVENT.LOGIN_FAILURE,
  /** `PERMISSION_DENIED_CODE` (`common/rbac/rbac.constants.ts`). */
  PERM_DENIED: PORTAL_AUDIT_EVENT.PERMISSION_DENIED,
  /** `SECURITY_ERROR_CODE.CSRF_TOKEN_MISSING` / `.CSRF_TOKEN_INVALID` (`common/security`). */
  CSRF_TOKEN_MISSING: PORTAL_AUDIT_EVENT.CSRF_REJECTED,
  CSRF_TOKEN_INVALID: PORTAL_AUDIT_EVENT.CSRF_REJECTED,
});

/**
 * `campaign_audit_trail.action` — transcribed from `ck_cat_action` on the live table.
 *
 * The database rejects anything else, so this union is not a stylistic preference: it is the
 * constraint, expressed where an agent will actually read it.
 */
export const CAMPAIGN_AUDIT_ACTION = Object.freeze({
  CREATED: 'created',
  UPDATED: 'updated',
  DELETED: 'deleted',
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  ASSIGNED: 'assigned',
  UNASSIGNED: 'unassigned',
  STATUS_CHANGED: 'status_changed',
} as const);

export type CampaignAuditAction =
  (typeof CAMPAIGN_AUDIT_ACTION)[keyof typeof CAMPAIGN_AUDIT_ACTION];

/** `campaign_audit_trail.entity_type` — transcribed from `ck_cat_entity_type`. */
export const CAMPAIGN_AUDIT_ENTITY_TYPE = Object.freeze({
  CAMPAIGN: 'campaign',
  TRACKER: 'tracker',
  TRACKER_COMPONENT: 'tracker_component',
  RULE_ASSIGNMENT: 'rule_assignment',
  REWARD_ASSIGNMENT: 'reward_assignment',
  CAP_OVERRIDE: 'cap_override',
  ENTITY_ASSIGNMENT: 'entity_assignment',
  CAMPAIGN_SUBMIT: 'campaign_submit',
  CAMPAIGN_APPROVAL: 'campaign_approval',
} as const);

export type CampaignAuditEntityType =
  (typeof CAMPAIGN_AUDIT_ENTITY_TYPE)[keyof typeof CAMPAIGN_AUDIT_ENTITY_TYPE];

/** `portal_audit_log.target_type` / `.target_id` are `varchar(60)`. Values are truncated, not rejected. */
export const AUDIT_TARGET_COLUMN_LIMIT = 60;

/** `portal_audit_log.event_type` is `varchar(60)` as well. */
export const AUDIT_EVENT_COLUMN_LIMIT = 60;

/** `campaign_audit_trail.comment` is `varchar(500)`. */
export const AUDIT_COMMENT_COLUMN_LIMIT = 500;
