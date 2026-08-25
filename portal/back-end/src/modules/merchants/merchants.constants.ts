/**
 * T-036 — constants shared by the DTOs, the service and the tests.
 *
 * Column widths are transcribed from `reward_config.merchants` / `merchant_stores` /
 * `merchant_activities` (`database/reward_config_postgres.sql`): `merchant_code varchar(50)`,
 * `name varchar(200)`, `description varchar(500)`, `contact_email varchar(255)`,
 * `contact_phone varchar(20)`, `website varchar(500)`, `country_code char(2)`,
 * `status varchar(20) check (status in ('active','inactive','suspended'))`,
 * `store_code varchar(50)`, `address varchar(500)`, `city/state varchar(100)`,
 * `postal_code varchar(20)`, `region varchar(50)`, `latitude/longitude decimal(10,7)`,
 * `commission_rate decimal(5,2)`.
 */

/** `role_entity_permissions.entity` for merchants, their stores and their activity links —
 * one row (01-DATABASE.md §5.1, T004_001 seed: `tenant_admin` holds `view,create,update`) covers
 * all three sub-resources; the task's own scope note has no separate entity for stores/
 * activities. */
export const MERCHANT_ENTITY = 'merchant';

export const MERCHANT_CODE_MAX_LENGTH = 50;
export const MERCHANT_NAME_MAX_LENGTH = 200;
export const MERCHANT_DESCRIPTION_MAX_LENGTH = 500;
export const MERCHANT_CONTACT_EMAIL_MAX_LENGTH = 255;
export const MERCHANT_CONTACT_PHONE_MAX_LENGTH = 20;
export const MERCHANT_WEBSITE_MAX_LENGTH = 500;
/** `country_code char(2)` — ISO-3166 alpha-2, uppercase (implementation note 3). */
export const MERCHANT_COUNTRY_CODE_LENGTH = 2;

/** `ck_m_status`. */
export const MERCHANT_STATUSES = ['active', 'inactive', 'suspended'] as const;
export type MerchantStatusValue = (typeof MERCHANT_STATUSES)[number];

/** The one status that leaves a merchant's `merchant`-role users' sessions usable
 * (`session.service.ts`'s parent-status backstop, implementation note 8). */
export const MERCHANT_ACTIVE_STATUS = 'active';

export const MERCHANT_STORE_CODE_MAX_LENGTH = 50;
export const MERCHANT_STORE_NAME_MAX_LENGTH = 200;
export const MERCHANT_STORE_ADDRESS_MAX_LENGTH = 500;
export const MERCHANT_STORE_CITY_MAX_LENGTH = 100;
export const MERCHANT_STORE_STATE_MAX_LENGTH = 100;
export const MERCHANT_STORE_POSTAL_CODE_MAX_LENGTH = 20;
export const MERCHANT_STORE_REGION_MAX_LENGTH = 50;

/** `commission_rate decimal(5,2)` — implementation note 5: "validate 0–100 with at most 2
 * decimals, and reject values that would overflow the column rather than letting the DB
 * truncate." 0–100 with 2 fractional digits always fits `decimal(5,2)` (max `999.99`), so the
 * range check alone is sufficient to also guarantee no overflow. */
export const COMMISSION_RATE_MIN = 0;
export const COMMISSION_RATE_MAX = 100;
export const COMMISSION_RATE_MAX_FRACTION_DIGITS = 2;

export const DEFAULT_PAGE_SIZE = 20;
/** 03-API-CONTRACT.md §1 — "`pageSize` capped at 100". */
export const MAX_PAGE_SIZE = 100;

/** `?search=` (TC-21) — matched against `merchantCode`/`name`, case-insensitively. */
export const MERCHANT_SEARCH_MAX_LENGTH = 100;

/** "Active campaign" for the deactivation warning (TC-20) and `GET /:id/active-campaigns` —
 * the same literal-word narrowing `rules/rewards campaign-usage.query.ts` document at length
 * for their own `ACTIVE_CAMPAIGN_STATUSES`: `tenant_campaigns.status = 'active'` only, not
 * every non-terminal status. */
export const ACTIVE_CAMPAIGN_STATUSES = ['active'] as const;

/** `session.constants.ts`'s `REVOCATION_REASON`/audit-event vocabulary has no merchant-
 * deactivation entry of its own (that file is `back-end/src/modules/auth/**`, outside this
 * task's file scope — AGENT-PROTOCOL R9) — this is this module's own literal, passed through as
 * a plain string to `SessionService.revokeAllForUser`, which accepts any string reason/event. */
export const MERCHANT_SESSION_REVOCATION_REASON = 'merchant_deactivated';
export const MERCHANT_SESSION_REVOCATION_AUDIT_EVENT = 'merchant_deactivated';
