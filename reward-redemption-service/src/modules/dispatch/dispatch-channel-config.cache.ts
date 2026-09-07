import { Inject, Injectable, Optional } from '@nestjs/common';
import type {
  DispatchChannelConfigRow,
  DispatchScopeLevel,
} from '@/database/models/dispatch-channel-config.model';
import { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';
import { DispatchChannelConfigRepository } from './dispatch-channel-config.repository';

/**
 * T-RR-069. Injection token for the *real*, invalidation-endpoint-and-reconciliation-poller-
 * connected `dispatchChannelConfig` cache (`tenant-schema-cache/dispatch-channel-config.cache.ts`,
 * T-RR-007) — see this file's own "T-RR-069" doc block below for why this class keeps its own
 * independent `TtlCache` as a fallback rather than being deleted outright. A `Symbol`, not the
 * class itself, because the class this token ultimately resolves to lives in another agent's file
 * scope (`src/modules/tenant-schema-cache/**`, R3) and this file must not import it as anything
 * more than the narrow structural shape declared below — `dispatch.module.ts` (this task's own
 * file) is the only place that imports the concrete class, to bind this token via `useExisting`.
 */
export const DISPATCH_CHANNEL_CONFIG_REAL_CACHE = Symbol('DISPATCH_CHANNEL_CONFIG_REAL_CACHE');

/**
 * T-RR-069. The one contract this cache needs from the real, shared `dispatchChannelConfig` cache
 * to delegate to it — deliberately a narrow structural interface (matching
 * `tenant-schema-cache/dispatch-channel-config.cache.ts`'s own public `get`/`invalidate` shape)
 * rather than importing that class as a compile-time dependency of this file. See
 * `dispatch.module.ts`'s own header for how `DISPATCH_CHANNEL_CONFIG_REAL_CACHE` is bound to the
 * actual singleton `CacheInvalidationService`/`ReconciliationPollerService` already operate on.
 */
export interface RealDispatchChannelConfigCacheSource {
  get(key: {
    scopeLevel: DispatchScopeLevel;
    scopeRefCode: string | null;
    tenantId: number | null;
  }): Promise<DispatchChannelConfigRow | null>;
  invalidate(): void;
}

/**
 * `06-CACHING-AND-TENANT-CONFIG.md` §2's own dot-namespaced key for this cache's TTL — a
 * `service_config` value, never a hardcoded number (requirement #8). Unlike the `serviceConfig`
 * cache itself (T-RR-007's own bootstrap exception, §2), this cache has no bootstrap paradox: this
 * task's `ServiceConfigResolverService` (T-RR-006) owns no cache of its own and simply queries
 * `service_config` directly on every call, so there is no "cache needs its own TTL before anything
 * is cached yet" chicken-and-egg problem here — an unseeded key is a genuine configuration gap and
 * surfaces immediately as `ServiceConfigNotFoundError`, exactly as intended (never a silent
 * fallback).
 */
const CACHE_TTL_CONFIG_KEY = 'cache.ttl.dispatchChannelConfig.seconds';

/** The one cache name `06-CACHING-AND-TENANT-CONFIG.md` §1/§3 and T-RR-007's generic
 * `POST /api/v1/cache/invalidate` endpoint both address this cache by. */
export const DISPATCH_CHANNEL_CONFIG_CACHE_NAME = 'dispatchChannelConfig';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Generic Map-backed TTL store, matching the shape T-RR-007's implementation note 8 specifies for
 * every one of the five caches this service defines (`get`/`set`/`invalidate`) — ported here
 * directly rather than imported, since T-RR-033 depends only on T-RR-003/T-RR-006 (not T-RR-007;
 * see this file's own module-level "cross-task note" below) and cannot assume T-RR-007's own
 * generic cache primitive exists yet at the time this task runs. `now` is injectable so tests can
 * advance time deterministically (TC-7) without a real `setTimeout`/sleep.
 */
export class TtlCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  /** No `key` clears every entry (the shape `POST /api/v1/cache/invalidate {"key":
   * "dispatchChannelConfig"}` needs, §3 — clears the whole named cache, never a single row); a
   * `key` clears just that one entry. */
  invalidate(key?: string): void {
    if (key === undefined) {
      this.store.clear();
      return;
    }
    this.store.delete(key);
  }
}

function cacheKey(
  scopeLevel: DispatchScopeLevel,
  scopeRefCode: string | null,
  tenantId: number | null,
): string {
  return `${scopeLevel}::${scopeRefCode ?? ''}::${tenantId ?? ''}`;
}

/** `null` is a valid, cacheable outcome ("confirmed: no row exists for this exact triple") —
 * distinct from `undefined`, which means "not in the cache at all, go ask the repository." */
type CachedLookup = DispatchChannelConfigRow | null;

/**
 * The `dispatchChannelConfig` cache (`06-CACHING-AND-TENANT-CONFIG.md` §1's own row) —
 * keyed exactly by `(scope_level, scope_ref_code, tenant_id)`, matching `uq_dcc_scope`
 * (implementation note 3), never by the caller's own `resolve()` input shape. This is what lets
 * `DispatchChannelResolverService` walk `REWARD → TRACKER → CAMPAIGN → GLOBAL` — and, within each
 * level, tenant-specific before tenant-agnostic (TC-5) — as independent, individually-cached
 * lookups, each served from cache after its first miss (TC-7), rather than caching one opaque
 * blob per full `resolve()` call shape.
 *
 * **Cross-task note for whoever reviews/wires T-RR-007.** `06-CACHING-AND-TENANT-CONFIG.md` §1
 * lists `dispatchChannelConfig` as one of the five caches T-RR-007's own task file also names in
 * its "Files owned" list (`dispatch-channel-config.cache.ts`, under
 * `src/modules/tenant-schema-cache/`) — a different path than this file. T-RR-033's own task file
 * is unambiguous that *this* task owns the real `dispatchChannelConfig` cache
 * (`src/modules/dispatch/dispatch-channel-config.cache.ts`, listed in T-RR-033's "Files owned",
 * with an explicit "repository/cache layer" in its own Scope §"In"). T-RR-033 does not depend on
 * T-RR-007 (only T-RR-003/T-RR-006), so this task proceeded on its own explicit file list rather
 * than blocking on that discrepancy. Flagged in T-RR-033's completion report for the architect to
 * reconcile — T-RR-007 should import and wire *this* class (via a small, named export) into its
 * own `CacheInvalidationService`/`ReconciliationPollerService` rather than building a second,
 * independent `dispatchChannelConfig` cache implementation.
 *
 * **T-RR-069 — this cross-task note's own prediction came true, and here is the fix.**
 * `CacheInvalidationService`/`ReconciliationPollerService` (T-RR-007) only ever knew about
 * `tenant-schema-cache/dispatch-channel-config.cache.ts`'s own
 * instance — never *this* one, the one `DispatchChannelResolverService` (T-RR-033) actually reads
 * for every real Kafka-vs-REST routing decision. `POST /api/v1/cache/invalidate
 * {"key":"dispatchChannelConfig"}` and the reconciliation poller's own clock therefore never
 * reached the cache that mattered — a functional no-op against real routing behaviour, not just an
 * ordinary staleness window (see T-RR-069's own task file for the full reproduction).
 *
 * The "likely fix shape" T-RR-069's own filer suggested — delete this file outright and have
 * `DispatchChannelResolverService` depend on `tenant-schema-cache`'s class directly — turned out
 * to be blocked by `AGENT-PROTOCOL.md` R3: `test/redemption/redemption-completion-side-effects.spec.ts`
 * (`agent-rr-processing`) and `test/e2e/{observability.e2e-spec.ts,fixtures/reward-entry.fixtures.ts}`
 * (`agent-rr-qa`) all construct `new DispatchChannelConfigCache(repository, serviceConfigResolver)`
 * directly, by that exact two-argument shape, from *this* file's own path — none of those files are
 * in this task's ("agent-rr-integration") file scope to edit, and changing this class's public
 * shape would break their compilation. Deleting this class was therefore not achievable without
 * either widening this task's file grant into two other agents' owned directories (against the
 * task's own "do not widen it to the whole directory" instruction) or leaving this task permanently
 * blocked on cross-agent coordination for a same-day, high-risk defect fix.
 *
 * **The fix actually shipped**: this class keeps its existing public shape (so every existing
 * 2-/3-argument construction — the fake-backed unit tests in
 * `dispatch-channel-resolver.spec.ts` and the real-Postgres integration tests listed above — keeps
 * working, self-contained, exactly as before) and gains one additional, `@Optional()`,
 * token-injected fourth constructor parameter: `RealDispatchChannelConfigCacheSource`, bound in
 * `dispatch.module.ts` (via `DISPATCH_CHANNEL_CONFIG_REAL_CACHE`) to the *actual* singleton
 * `tenant-schema-cache/dispatch-channel-config.cache.ts` instance `CacheInvalidationService`/
 * `ReconciliationPollerService` already operate on. When that delegate is present (the real,
 * DI-constructed app/worker graph), `lookup()`/`invalidate()` forward to it entirely, bypassing this
 * class's own `TtlCache` — so the exact same cache the endpoint clears and the poller refreshes is
 * now the one `DispatchChannelResolverService` reads in production. When absent (every direct,
 * non-DI construction above), this class behaves exactly as it always has. See
 * `test/dispatch/dispatch-channel-config-cache-delegation.e2e-spec.ts` for the regression proof.
 */
@Injectable()
export class DispatchChannelConfigCache {
  readonly cacheName = DISPATCH_CHANNEL_CONFIG_CACHE_NAME;

  private readonly ttlCache: TtlCache<CachedLookup>;

  constructor(
    private readonly repository: DispatchChannelConfigRepository,
    private readonly serviceConfig: ServiceConfigResolverService,
    @Optional() now?: () => number,
    @Optional()
    @Inject(DISPATCH_CHANNEL_CONFIG_REAL_CACHE)
    private readonly realSource?: RealDispatchChannelConfigCacheSource,
  ) {
    this.ttlCache = new TtlCache<CachedLookup>(now);
  }

  /**
   * The cached (or freshly-fetched-and-cached) row for one exact triple. `null` is cached exactly
   * like a real row — a confirmed miss is just as worth not re-querying within the TTL window as a
   * hit (TC-7 makes no exception for "the level that didn't match").
   *
   * T-RR-069: when `realSource` is wired (the real DI graph), this delegates entirely to it —
   * this class's own `ttlCache` is never consulted in that mode, so there is exactly one cached
   * answer for a given triple, not two independently-aging ones.
   */
  async lookup(
    scopeLevel: DispatchScopeLevel,
    scopeRefCode: string | null,
    tenantId: number | null,
  ): Promise<CachedLookup> {
    if (this.realSource) {
      return this.realSource.get({ scopeLevel, scopeRefCode, tenantId });
    }

    const key = cacheKey(scopeLevel, scopeRefCode, tenantId);
    const cached = this.ttlCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const row = await this.repository.findOne(scopeLevel, scopeRefCode, tenantId);
    const ttlSeconds = await this.serviceConfig.resolve(CACHE_TTL_CONFIG_KEY, 'int');
    this.ttlCache.set(key, row, ttlSeconds * 1000);
    return row;
  }

  /** `POST /api/v1/cache/invalidate {"key": "dispatchChannelConfig"}` (T-RR-007) addresses this
   * cache through this method — clears every cached entry, never eagerly re-fetches (§3's own
   * "thundering herd" reasoning: the next `lookup()` re-fills lazily). T-RR-069: forwards to
   * `realSource` when wired, for the same single-source-of-truth reason as `lookup()` above —
   * though nothing in production calls this method directly on `DispatchChannelResolverService`'s
   * own instance today (only the real, shared `realSource` instance is ever registered with
   * `CacheInvalidationService`), it stays correct for any future direct caller. */
  invalidate(): void {
    if (this.realSource) {
      this.realSource.invalidate();
      return;
    }
    this.ttlCache.invalidate();
  }
}
