/**
 * T-RR-007. A minimal, generically-typed in-memory TTL cache — the one shape all four caches this
 * task owns share (implementation note 8: "not four independently-shaped ad hoc caching
 * implementations"). Just a `Map` plus an expiry timestamp per entry; no eviction sweep or
 * background timer of its own — TTL-on-read, the invalidation endpoint (`cache-invalidation`
 * module) and `ReconciliationPollerService` together are this service's entire freshness
 * mechanism (`06-CACHING-AND-TENANT-CONFIG.md` §4), not this class.
 *
 * Deliberately per-instance, in-memory only — never Redis, never shared across running instances
 * of this service (`06-CACHING-AND-TENANT-CONFIG.md` §1's own cited reasoning, reused unmodified
 * here). Do not add a shared-cache backend to this class "for consistency" with some other
 * project.
 */
export class TtlCache<K, V> {
  private readonly store = new Map<K, { value: V; expiresAt: number }>();

  /** Defaults to the real clock; a test may inject a fake one to control expiry deterministically
   * without sleeping in real time. */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * `undefined` means "not cached" — either never set, evicted by `invalidate`, or expired.
   * Never confused with a legitimately cached value: every caller of this class represents "the DB
   * confirmed no row exists" by caching `null`, not `undefined` — `undefined` is reserved as this
   * class's own private "miss" sentinel.
   */
  get(key: K): V | undefined {
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

  set(key: K, value: V, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  /** Clears exactly `key`, or the whole cache when `key` is omitted — the same two shapes
   * `POST /api/v1/cache/invalidate` itself accepts (`{"key": "..."}` vs `{"all": true}`). Clears
   * only; never eagerly re-fetches (§3's explicit "no thundering herd" reasoning) — the next `get`
   * miss re-fills lazily via whatever calls this cache's own `set`. */
  invalidate(key?: K): void {
    if (key === undefined) {
      this.store.clear();
      return;
    }
    this.store.delete(key);
  }

  get size(): number {
    return this.store.size;
  }
}
