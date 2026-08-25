/**
 * T-041 — constants shared by the DTOs, `BlastsService` and its tests.
 *
 * ### Why every route here carries `@Roles`, never `@RequirePermission`
 *
 * `role_entity_permissions` has no `blast` entity (`versions.constants.ts`'s header has the
 * full reasoning, identical here — this module was born alongside `versions/**` and the seed
 * migration that would add such a row is outside both modules' `Files owned`). `POST /blasts`
 * and `POST /blasts/preview` are `@Roles('super_admin')` (implementation note: "the blast").
 * `GET /blasts`/`GET /blasts/:id` are `@Roles('super_admin', 'country_admin')` — the Endpoints
 * table's own two-role list — with `country_admin` narrowed to blasts targeting their own
 * country inside the service (`VersionBlastTarget`'s scope-strategy entry does that narrowing;
 * see `blasts.service.ts`'s header).
 */

export const DEFAULT_PAGE_SIZE = 20;
/** 03-API-CONTRACT.md §1 — "`pageSize` capped at 100". */
export const MAX_PAGE_SIZE = 100;

export const BLAST_NOTE_MAX_LENGTH = 500;

export const VERSION_ENTITY_TYPES = ['rule', 'reward'] as const;
export type VersionEntityTypeValue = (typeof VERSION_ENTITY_TYPES)[number];

export const BLAST_SCOPES = ['all_countries', 'selected'] as const;
export type BlastScopeValue = (typeof BLAST_SCOPES)[number];

/** `tenant_campaigns.status` values counted as "an active campaign" for the preview's
 * `activeCampaignsOnCurrentVersion` figure — see `versions.constants.ts`'s own note on why this
 * is narrowed to one literal value ahead of T-037. */
export const ACTIVE_CAMPAIGN_STATUSES = ['active'] as const;

/** `countries.status` values eligible for an `all_countries` blast — an inactive country is not
 * offered new configuration (mirrors `CountriesService`'s own `COUNTRY_STATUSES` active check). */
export const ACTIVE_COUNTRY_STATUS = 'active';
