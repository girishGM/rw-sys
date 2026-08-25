/**
 * T-013 — the permission matrix, cached, with a version counter that defeats the cache
 * (implementation note 5).
 *
 * ### What is cached, and what deliberately is not
 *
 * Cached: **the permission matrix for a role** — up to fifteen rows of
 * `role_entity_permissions`, parsed into a map. That is the expensive read, and it changes only
 * when a Super Admin edits Access Control.
 *
 * Not cached: **`rbac_version:<role>`**. It is read on every check, and that is the whole
 * mechanism. T-013 TC-16 requires that removing a permission and bumping the version takes
 * effect *within* the TTL — "version bump defeats the cache" — which is impossible if the
 * version itself is served from a cache with the same TTL, and equally impossible if the version
 * is taken from the JWT (a 15-minute-old token carries a 15-minute-old version, so the key would
 * not change at all and the stale entry would keep being served until the token expired).
 *
 * The cost is one single-row lookup on a unique index per authorisation check, in exchange for
 * the multi-row matrix read being served from memory. That is the right side of the trade: the
 * expensive query is the one avoided, and permission revocation is immediate across every
 * instance rather than eventually-consistent to within a TTL. 08-OBSERVABILITY.md's latency
 * budget already accounts for `SessionValidGuard`'s per-request query; this is a second one of
 * the same shape.
 *
 * ### Fail-closed is the only default (TC-17)
 *
 * Nothing in this file catches a store error and substitutes a value. A read that fails throws,
 * `PermissionsGuard` denies, and the request gets a 403. The tempting alternative — "serve the
 * last known good entry when the database is down" — is an availability optimisation that makes
 * a revoked permission survive an outage, which is exactly when a revocation is most likely to
 * matter.
 *
 * ### One entry per role, keyed by version
 *
 * The cache holds at most six entries — one per role — each stamped with the version it was
 * read at. A version mismatch is a miss regardless of TTL. Keying by `role + version` in the map
 * itself would grow without bound as versions climb; stamping the version inside a
 * role-keyed entry gives the same invalidation with a fixed footprint.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PortalRole } from '@/database/portal-models';
import { DEFAULT_RBAC_TTL_SECONDS } from './rbac.constants';
import { PERMISSION_STORE, type PermissionStore } from './permission.repository';

/** `entity → actions`. Sets, not arrays: membership is the only question ever asked. */
export type PermissionMap = ReadonlyMap<string, ReadonlySet<string>>;

interface CacheEntry {
  readonly version: number;
  readonly expiresAt: number;
  readonly permissions: PermissionMap;
}

@Injectable()
export class PermissionCacheService {
  private readonly logger = new Logger(PermissionCacheService.name);
  private readonly entries = new Map<PortalRole, CacheEntry>();

  /** Cached TTL, refreshed whenever a matrix is re-read. `null` until the first read. */
  private ttlSeconds: number | null = null;

  constructor(@Inject(PERMISSION_STORE) private readonly store: PermissionStore) {}

  /**
   * The permission map for a role, from cache when the cached version still matches the stored
   * one and the entry has not expired.
   *
   * `now` is injected rather than read from `Date.now()` inside so that TTL expiry is a
   * deterministic test rather than a timer, and so the guard, the bootstrap endpoint and the
   * tests all measure against the same clock.
   */
  async permissionsFor(role: PortalRole, now: Date = new Date()): Promise<PermissionMap> {
    const version = await this.store.readRbacVersion(role);
    const cached = this.entries.get(role);

    if (cached !== undefined && cached.version === version && cached.expiresAt > now.getTime()) {
      return cached.permissions;
    }

    const permissions = await this.readThrough(role);
    this.entries.set(role, {
      version,
      expiresAt: now.getTime() + (await this.resolveTtlSeconds()) * 1000,
      permissions,
    });

    return permissions;
  }

  /**
   * Whether `role` may perform `action` on `entity`.
   *
   * Exact set membership, never a substring or prefix test — see
   * `permission.repository.ts`'s note on why `"view"` matching `["review"]` would be a
   * privilege escalation rather than a cosmetic bug.
   */
  async isGranted(
    role: PortalRole,
    entity: string,
    action: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const permissions = await this.permissionsFor(role, now);
    return permissions.get(entity)?.has(action) === true;
  }

  /**
   * Publishes a permission change: bumps `rbac_version:<role>` so that **every** instance's
   * cache misses on its next check, and drops this instance's entry immediately.
   *
   * T-033's Access Control writes call this in the same transaction as the edit. Dropping the
   * local entry as well as bumping the counter is not redundant — it makes the instance that
   * performed the edit correct even if its own version read is momentarily served from a
   * replica.
   */
  async bumpVersion(role: PortalRole): Promise<number> {
    const version = await this.store.bumpRbacVersion(role);
    this.entries.delete(role);
    this.logger.log(`rbac_version:${role} bumped to ${version}; permission cache invalidated`);
    return version;
  }

  /** Drops one role's entry, or all of them. Diagnostics and tests; never a request path. */
  invalidate(role?: PortalRole): void {
    if (role === undefined) {
      this.entries.clear();
      this.ttlSeconds = null;
      return;
    }
    this.entries.delete(role);
  }

  /** Number of cached roles. Exposed so tests can assert a hit was a hit. */
  get size(): number {
    return this.entries.size;
  }

  private async readThrough(role: PortalRole): Promise<PermissionMap> {
    const grants = await this.store.findGrantsForRole(role);
    const map = new Map<string, ReadonlySet<string>>();

    for (const grant of grants) {
      // Two rows for the same entity should not exist (`role_entity_permissions` is unique on
      // `(role, entity)`), but if they ever do, union rather than last-wins: last-wins depends
      // on row order, which is undefined without an ORDER BY, and a permission check whose
      // answer depends on the planner is not a permission check.
      const existing = map.get(grant.entity);
      const merged = new Set(existing ?? []);
      for (const action of grant.actions) merged.add(action);
      map.set(grant.entity, merged);
    }

    return map;
  }

  private async resolveTtlSeconds(): Promise<number> {
    if (this.ttlSeconds !== null) return this.ttlSeconds;

    const configured = await this.store.readTtlSeconds();
    this.ttlSeconds = configured ?? DEFAULT_RBAC_TTL_SECONDS;
    if (configured === null) {
      this.logger.warn(
        `rbac_ttl_seconds is missing or invalid; using the ${DEFAULT_RBAC_TTL_SECONDS}s default`,
      );
    }
    return this.ttlSeconds;
  }
}
