/**
 * T-RR-007. The one contract `CacheInvalidationService` (`../cache-invalidation/`) needs from
 * each of the four caches this task owns — deliberately narrow (just "clear yourself"), so that
 * module's own registry can hold all four behind a single type without knowing anything about
 * what each one actually caches. See `cache-invalidation.service.ts`'s own header for the
 * registry this interface exists to support, and this task's implementation note 4 for why the
 * registry is a named extension point rather than a hardcoded list of four.
 */
export interface InvalidatableCache {
  /** Clears every entry this cache currently holds. Never eagerly re-fetches (§3's own
   * "no thundering herd" reasoning) — the next read that misses re-fills lazily. */
  invalidate(): void;

  /** Wholesale re-fetch from this cache's own source table/feed, regardless of whether any
   * individual key has been read since the last refresh — `ReconciliationPollerService`'s own
   * safety-net mechanism (`06-CACHING-AND-TENANT-CONFIG.md` §4). */
  refreshAll(): Promise<void>;
}
