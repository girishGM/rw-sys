/**
 * T-030 — constants shared by the DTOs, the service and the tests.
 *
 * Column widths are transcribed from `reward_config.countries`
 * (`database/reward_config_postgres.sql`): `code char(2)`, `name varchar(100)`,
 * `timezone varchar(50)`, `currency_code char(3)`, `dialing_code varchar(5)`,
 * `status varchar(20) check (status in ('active','inactive'))`.
 */

/** `role_entity_permissions.entity` for this module (01-DATABASE.md §5.1, T004_001 seed). */
export const COUNTRY_ENTITY = 'country';

export const COUNTRY_CODE_LENGTH = 2;
export const COUNTRY_NAME_MAX_LENGTH = 100;
export const COUNTRY_TIMEZONE_MAX_LENGTH = 50;
export const COUNTRY_CURRENCY_CODE_LENGTH = 3;
export const COUNTRY_DIALING_CODE_MAX_LENGTH = 5;

/** `ck_countries_status`. */
export const COUNTRY_STATUSES = ['active', 'inactive'] as const;
export type CountryStatusValue = (typeof COUNTRY_STATUSES)[number];

/** `portal_users.display_name varchar(100)` / `.email` input bound (see `portal-user.model.ts`). */
export const COUNTRY_ADMIN_EMAIL_MAX_LENGTH = 200;
export const COUNTRY_ADMIN_DISPLAY_NAME_MAX_LENGTH = 100;

export const DEFAULT_PAGE_SIZE = 20;
/** 03-API-CONTRACT.md §1 — "`pageSize` capped at 100". */
export const MAX_PAGE_SIZE = 100;

/** BACKLOG.md B-01 / T-046's own precedent: 24 characters from a CSPRNG. */
export const TEMPORARY_PASSWORD_LENGTH = 24;
