/**
 * T-034 — constants shared by the DTOs, the service and the tests.
 *
 * Column widths are transcribed from `reward_config.tenants` and
 * `reward_config.tenant_budget_ceilings` (`database/reward_config_postgres.sql` /
 * 11-BUDGETS-AND-LIMITS.md §8.2): `code varchar(20)`, `name varchar(100)`,
 * `schema_prefix varchar(10)`, `contact_email varchar(255)`, `contact_phone varchar(20)`,
 * `status varchar(20) check (status in ('pending_provisioning','active','inactive','suspended'))`,
 * `unit_type varchar(14)`, `unit_code varchar(10)`, `max_campaign_budget decimal(18,4)`,
 * `warn_above_amount decimal(18,4)`.
 */

/** `role_entity_permissions.entity` for tenant rows (01-DATABASE.md §5.1, T004_001 seed). */
export const TENANT_ENTITY = 'tenant';

/** `role_entity_permissions.entity` for `tenant_budget_ceilings` (11-BUDGETS-AND-LIMITS.md §8.3). */
export const TENANT_BUDGET_CEILING_ENTITY = 'tenant_budget_ceiling';

export const TENANT_CODE_MAX_LENGTH = 20;
export const TENANT_NAME_MAX_LENGTH = 100;
/** Implementation note 4 — `^[a-z][a-z0-9_]{0,9}$`, so the full string is at most 10 characters. */
export const TENANT_SCHEMA_PREFIX_MAX_LENGTH = 10;
export const TENANT_CONTACT_EMAIL_MAX_LENGTH = 255;
export const TENANT_CONTACT_PHONE_MAX_LENGTH = 20;

/** `ck_tenants_status`. */
export const TENANT_STATUSES = ['pending_provisioning', 'active', 'inactive', 'suspended'] as const;
export type TenantStatusValue = (typeof TENANT_STATUSES)[number];

/** The one status that leaves a tenant's sessions usable (`session.service.ts`'s own constant). */
export const TENANT_ACTIVE_STATUS = 'active';

/** `portal_users.display_name varchar(100)` / `.email` input bound — same as `country-admin`'s. */
export const TENANT_ADMIN_EMAIL_MAX_LENGTH = 200;
export const TENANT_ADMIN_DISPLAY_NAME_MAX_LENGTH = 100;

export const DEFAULT_PAGE_SIZE = 20;
/** 03-API-CONTRACT.md §1 — "`pageSize` capped at 100". */
export const MAX_PAGE_SIZE = 100;

/** BACKLOG.md B-01 / T-030's own precedent: 24 characters from a CSPRNG. */
export const TEMPORARY_PASSWORD_LENGTH = 24;

/** `ck_tbc_unit`. */
export const TENANT_BUDGET_CEILING_UNIT_TYPES = ['currency', 'points', 'voucher'] as const;
export type TenantBudgetCeilingUnitType = (typeof TENANT_BUDGET_CEILING_UNIT_TYPES)[number];

export const TENANT_BUDGET_CEILING_UNIT_CODE_MAX_LENGTH = 10;

/**
 * `decimal(18,4)` — 14 integer digits, 4 fractional. Generous enough for any real campaign
 * budget while still bounding the string a caller may submit.
 */
export const TENANT_BUDGET_CEILING_INTEGER_DIGITS = 14;
export const TENANT_BUDGET_CEILING_FRACTION_DIGITS = 4;

/** `session.constants.ts`'s `REVOCATION_REASON`/audit-event vocabulary has no tenant-suspension
 * entry of its own (that file is `back-end/src/modules/auth/**`, outside this task's file scope
 * — AGENT-PROTOCOL R9) — this is this module's own literal, passed through as a plain string to
 * `SessionService.revokeAllForUser`, which accepts any string reason/event. */
export const TENANT_SESSION_REVOCATION_REASON = 'tenant_suspended';
export const TENANT_SESSION_REVOCATION_AUDIT_EVENT = 'tenant_suspended';

/**
 * T-126 — `role_entity_permissions.entity` for `tenant_currencies`
 * (13-REWARD-MASTER-VALUE-SOURCES.md §4, `T126_002` seed).
 */
export const TENANT_CURRENCY_ENTITY = 'tenant_currency';

/** `char(3)` — an ISO-4217-shaped code, same width as `countries.currency_code`. */
export const TENANT_CURRENCY_CODE_LENGTH = 3;

/** `ck_tc_status`. */
export const TENANT_CURRENCY_STATUSES = ['active', 'inactive'] as const;
export type TenantCurrencyStatusValue = (typeof TENANT_CURRENCY_STATUSES)[number];
