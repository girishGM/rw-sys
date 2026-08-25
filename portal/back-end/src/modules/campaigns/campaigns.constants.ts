/**
 * T-037 — the fixed vocabularies and tuning constants `/campaigns` works from. Everything here
 * is either transcribed from a live database CHECK constraint or from a numbered design
 * decision; nothing is invented at a call site.
 */

/** `role_entity_permissions.entity` (T004_001's seed). */
export const CAMPAIGN_ENTITY = 'campaign';

export const DEFAULT_PAGE_SIZE = 20;
/** 03-API-CONTRACT.md §1 — `pageSize` capped at 100. */
export const MAX_PAGE_SIZE = 100;

/** `ck_tc_status`, verbatim. See `campaign.schema.ts` for why `returned` is not among them. */
export const CAMPAIGN_STATUS = Object.freeze({
  DRAFT: 'draft',
  PENDING_APPROVAL: 'pending_approval',
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  ARCHIVED: 'archived',
} as const);

/** The generic `active`/`inactive` pair every link table in `reward_config` uses. */
export const ROW_ACTIVE = 'active';
export const ROW_INACTIVE = 'inactive';

/** `ck_par_status` (T037_001). */
export const APPROVAL_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  RETURNED: 'returned',
} as const);

/** `ck_par_action`. A campaign submission is always a `create` decision on the campaign entity. */
export const APPROVAL_ACTION_CREATE = 'create';

/** `approval_requests.entity_type` for a campaign submission. */
export const APPROVAL_ENTITY_CAMPAIGN = 'campaign';

/**
 * How long a submitted campaign waits for a checker before it expires.
 *
 * `approval_policies` has no expiry column at all in the live schema (confirmed against
 * `information_schema.columns` — `entity_type`, `creator_role`, `requires_approval`,
 * `approver_role`, `tenant_id`, `status` and the timestamps, nothing more), while
 * `approval_requests.expires_at` is `NOT NULL`. Something therefore has to choose the value, and
 * a constant that is visible in one place beats a magic number at the one call site that writes
 * the column. Seven days is the shortest interval that survives a public holiday plus a weekend,
 * which is the realistic worst case for "the checker was not at their desk". T-038 owns the
 * expiry *behaviour*; this constant is only the horizon.
 */
export const APPROVAL_EXPIRY_DAYS = 7;

/**
 * `ck_pcat_entity_type` (T037_002), restating `ck_cat_entity_type`.
 *
 * `APPROVAL` was added by T-038: the CHECK constraint has always permitted `campaign_approval`
 * (see `T037_002`'s DDL), and the checker's three decisions are events on the *approval* rather
 * than on the campaign's content, so they carry their own entity type instead of overloading
 * `CAMPAIGN`. Additive only — no existing value changed, no DDL (R1).
 */
export const AUDIT_ENTITY = Object.freeze({
  CAMPAIGN: 'campaign',
  TRACKER: 'tracker',
  COMPONENT: 'tracker_component',
  RULE_ASSIGNMENT: 'rule_assignment',
  REWARD_ASSIGNMENT: 'reward_assignment',
  CAP_OVERRIDE: 'cap_override',
  SUBMIT: 'campaign_submit',
  APPROVAL: 'campaign_approval',
} as const);

/**
 * `ck_pcat_action`.
 *
 * `APPROVED`/`REJECTED` were added by T-038 for the same reason as `AUDIT_ENTITY.APPROVAL` above:
 * the constraint already permits both, and T-038 TC-23 requires an audit row whose `action` is
 * literally `approved`. There is deliberately **no** `RETURNED`: the CHECK does not permit it, and
 * R1 forbids widening the constraint — a return is recorded as `STATUS_CHANGED` with the decision
 * in `field_changes`, mirroring how `campaign-state-machine.ts` already handles `returned` not
 * being a storable campaign status.
 */
export const AUDIT_ACTION = Object.freeze({
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

/**
 * Prefixes for the codes the wizard generates on the maker's behalf.
 *
 * `trackers.tracker_code` and `tracker_components.component_code` are `NOT NULL` and unique per
 * tenant, but the wizard never asks a maker for either: they are plumbing, not a business
 * decision, and a "code" field in a journey builder is exactly the kind of incidental complexity
 * 04-FRONTEND.md §5.3 leaves out. `journey.service.ts#generateCode` builds them from these
 * prefixes plus the campaign id and a random suffix, and retries on the unique constraint.
 */
export const TRACKER_CODE_PREFIX = 'TRK';
export const COMPONENT_CODE_PREFIX = 'CMP';

/** `varchar(50)` on both `tracker_code` and `component_code`. */
export const GENERATED_CODE_MAX_LENGTH = 50;

/** How many times `generateCode` retries a `uq_*_tenant_code` collision before giving up. Three
 * collisions on a 6-character base-36 suffix is ~1 in 10^13; reaching it means something other
 * than chance is wrong, and looping forever would hide that. */
export const CODE_GENERATION_ATTEMPTS = 3;

/**
 * How many checkers one submission may notify.
 *
 * Implementation note 13 says "notify checkers" — plural, and unbounded in principle. A tenant
 * with an unexpected number of checker accounts would otherwise turn one submit into an
 * unbounded write loop inside the request. The cap is generous enough that no real tenant
 * reaches it and small enough that a misconfigured one fails visibly rather than slowly.
 */
export const MAX_CHECKERS_NOTIFIED = 50;
