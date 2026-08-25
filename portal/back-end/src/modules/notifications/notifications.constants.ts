/**
 * T-040 — the vocabulary of `reward_config.user_notifications.notification_type`.
 *
 * `notification_type` is a free `varchar(30)` with no `CHECK` constraint (confirmed against the
 * live database, not assumed — `information_schema.columns` for this table carries no
 * `ck_un_*` row), so this union is an **application-level** whitelist rather than a transcribed
 * database constraint, unlike `CAMPAIGN_AUDIT_ACTION` in `common/audit/audit.constants.ts`. It
 * exists so a Wave 3 producer (T-034 tenant activation, T-035 user creation, T-037/T-038 campaign
 * submit/approve/reject/return) calls {@link NotificationsService.notify} with a value this file
 * has already agreed on, rather than each task inventing its own string.
 *
 * Implementation note 2's list, verbatim: *"campaign submitted (→ checkers), approved / rejected
 * / returned (→ maker), user created (→ new user), tenant activated (→ tenant admin)."*
 */

export const NOTIFICATION_TYPE = Object.freeze({
  CAMPAIGN_SUBMITTED: 'campaign_submitted',
  CAMPAIGN_APPROVED: 'campaign_approved',
  CAMPAIGN_REJECTED: 'campaign_rejected',
  CAMPAIGN_RETURNED: 'campaign_returned',
  USER_CREATED: 'user_created',
  TENANT_ACTIVATED: 'tenant_activated',
} as const);

export type NotificationType = (typeof NOTIFICATION_TYPE)[keyof typeof NOTIFICATION_TYPE];

/** Column widths, transcribed from the live `user_notifications` DDL (01-DATABASE.md §3). */
export const NOTIFICATION_TITLE_LIMIT = 200;
export const NOTIFICATION_MESSAGE_LIMIT = 500;
export const NOTIFICATION_ENTITY_LABEL_LIMIT = 200;

/** `03-API-CONTRACT.md §1`: pagination is capped, not rejected, at 100 per page. */
export const NOTIFICATION_MAX_PAGE_SIZE = 100;
export const NOTIFICATION_DEFAULT_PAGE_SIZE = 20;
