/**
 * T-013 — the frozen values the RBAC layer shares. Metadata keys, the one error code, and the
 * cache-configuration keys.
 *
 * Metadata keys are namespaced (`rbac:…`) for the reason `public.decorator.ts` gives about
 * `auth:isPublic`: `SetMetadata` writes into a flat, process-wide namespace, and a collision
 * between two modules' keys would be silent and would express itself as a guard reading
 * somebody else's metadata.
 */

import type { PortalRole } from '@/database/portal-models';

/** `@Roles(...)` — the list of roles allowed anywhere near a route. */
export const ROLES_METADATA_KEY = 'rbac:roles';

/**
 * All six roles — for the handful of routes 03-API-CONTRACT.md marks **Access: any**, which today
 * means `/auth/logout`, `/auth/logout-all`, `/auth/change-password`, `/auth/sessions` and
 * `/me/*` (T-015).
 *
 * Spelling the list out is deliberate, and it is *not* the same as omitting `@Roles` entirely.
 * An omitted decorator is now a denial (TC-18) precisely because "I forgot" and "everyone may"
 * must not look alike; this constant is how a route says the second one on purpose, and it shows
 * up as such in the route-guard inventory of 03-API-CONTRACT.md §15. If a seventh role is ever
 * added (00-ARCHITECTURE.md §5.4 discusses "Regional Admin"), the type checker points here.
 */
export const ALL_PORTAL_ROLES: readonly PortalRole[] = Object.freeze([
  'super_admin',
  'country_admin',
  'tenant_admin',
  'maker',
  'checker',
  'merchant',
]);

/** `@RequirePermission(entity, action)` — the runtime-configurable check. */
export const PERMISSION_METADATA_KEY = 'rbac:permission';

/**
 * The **only** code an authorisation failure returns (03-API-CONTRACT.md §1, T-013 TC-2/TC-3).
 *
 * One code for every cause — wrong role, missing permission, unguarded route, cache outage. A
 * finer taxonomy would tell a caller probing an endpoint which layer stopped them, which is a
 * map of the authorisation model drawn by the system it protects.
 */
export const PERMISSION_DENIED_CODE = 'PERM_DENIED';

/** `rbac_cache_config` keys (seeded by T004_005). */
export const RBAC_CONFIG_KEY = {
  /** Global TTL for a cached permission map, in seconds. */
  TTL_SECONDS: 'rbac_ttl_seconds',
  /** Per-role generation counter: `rbac_version:<role>`. */
  versionFor: (role: string): string => `rbac_version:${role}`,
} as const;

/**
 * TTL used when `rbac_ttl_seconds` is missing or unparseable.
 *
 * Matches T004_005's seeded value. A missing tuning row must not change behaviour beyond making
 * the cache colder — it grants nothing, so failing the request over it would be the wrong trade
 * (the same reasoning `SessionRepository.readRbacVersion` records for its `0` fallback).
 */
export const DEFAULT_RBAC_TTL_SECONDS = 300;
