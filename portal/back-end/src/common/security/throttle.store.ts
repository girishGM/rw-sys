/**
 * T-012 — where rate-limit counters live (02-SECURITY.md §8: "in-memory for local development
 * and **Redis in any multi-instance deployment** — an in-memory limiter across N pods is an
 * N-times weaker limiter").
 *
 * ---
 *
 * ### Why this is an interface with three implementations rather than `@nestjs/throttler`
 *
 * The same constraint as `security.middleware.ts` and helmet: `@nestjs/throttler` is not a
 * workspace dependency and this environment cannot add one. That is the reason it is not used;
 * it is not the reason the shape is what it is. Even with the library present, AR-11 requires
 * behaviour it does not offer — *asymmetric* failure handling, fail-closed on the auth routes
 * and fail-open everywhere else — and the library's own documented behaviour on a store outage
 * is fail-open for both. Expressing the store as an interface that is allowed to **reject**,
 * and letting the guard decide what a rejection means per route, is what makes that asymmetry
 * visible in the code rather than buried in a library's defaults (T-012 implementation note 8).
 *
 * ### The three implementations, and when each is chosen
 *
 * | `REDIS_URL` | client library present | store | consequence |
 * |---|---|---|---|
 * | unset | — | {@link MemoryThrottleStore} | correct for one instance; warns at boot if `APP_INSTANCE_COUNT > 1` |
 * | set | yes | {@link RedisThrottleStore} | counters shared across instances |
 * | set | **no** | {@link UnavailableThrottleStore} | every call rejects |
 *
 * The third row is the important one. An operator who sets `REDIS_URL` has stated that this is
 * a multi-instance deployment; silently falling back to per-process counters there would leave
 * them believing they have a limiter N times stronger than the one they actually have. That is
 * the precise failure AR-11 exists to prevent, so the fallback is *not* silent and *not* to
 * memory: the store rejects, which fails the login path closed (503) and leaves general API
 * traffic running unthrottled but available — exactly the documented outage posture, reached
 * deliberately instead of by accident.
 */
import { createRequire } from 'node:module';
import { Logger } from '@nestjs/common';
import { THROTTLE_MEMORY_MAX_KEYS, THROTTLE_MULTI_INSTANCE_WARNING } from './security.constants';

/**
 * DI token for the chosen {@link ThrottleStore}, bound once in `security.module.ts` — the same
 * pattern `CREDENTIAL_STORE` and `SESSION_STORE` use, and for the same reason: it is what lets
 * `RateLimitGuard` be tested against a store that fails on demand, which is the only way to
 * exercise AR-11's asymmetry at all.
 */
export const THROTTLE_STORE = Symbol('THROTTLE_STORE');

/** The state of one counter after a request has been counted against it. */
export interface ThrottleCounter {
  /** Requests counted in the current window, including this one. */
  readonly count: number;
  /** Epoch milliseconds at which the current window ends. */
  readonly resetAt: number;
}

/**
 * A fixed-window counter store.
 *
 * `consume` **may reject** — that is part of the contract, not an accident. `RateLimitGuard`
 * catches the rejection and applies the route's declared failure policy.
 */
export interface ThrottleStore {
  readonly kind: 'memory' | 'redis' | 'unavailable';
  consume(key: string, windowMs: number, now: number): Promise<ThrottleCounter>;
}

/** Raised by {@link UnavailableThrottleStore}; also the shape a Redis outage produces. */
export class ThrottleStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThrottleStoreUnavailableError';
    Error.captureStackTrace?.(this, ThrottleStoreUnavailableError);
  }
}

interface MemoryEntry {
  count: number;
  resetAt: number;
}

/**
 * In-process counters. Correct for a single instance and for local development; explicitly
 * *not* correct for several instances, which is what the boot warning is for.
 *
 * Bounded by {@link THROTTLE_MEMORY_MAX_KEYS} — see that constant for why an unbounded map here
 * would itself be an unauthenticated denial-of-service vector.
 */
export class MemoryThrottleStore implements ThrottleStore {
  readonly kind = 'memory' as const;

  private readonly entries = new Map<string, MemoryEntry>();

  constructor(private readonly maxKeys: number = THROTTLE_MEMORY_MAX_KEYS) {}

  /** Live key count. Exposed so the eviction behaviour can be asserted rather than assumed. */
  get size(): number {
    return this.entries.size;
  }

  async consume(key: string, windowMs: number, now: number): Promise<ThrottleCounter> {
    const existing = this.entries.get(key);

    if (existing !== undefined && existing.resetAt > now) {
      existing.count += 1;
      return { count: existing.count, resetAt: existing.resetAt };
    }

    if (existing === undefined && this.entries.size >= this.maxKeys) {
      this.makeRoom(now);
    }

    const entry: MemoryEntry = { count: 1, resetAt: now + windowMs };
    this.entries.set(key, entry);
    return { count: entry.count, resetAt: entry.resetAt };
  }

  /**
   * Drops expired entries; if that was not enough, drops the ones closest to expiring.
   *
   * Evicting a live counter forgets that somebody was being limited, which is a weakening — but
   * a bounded and deliberate one, chosen over the alternative of letting a flood of forged
   * source addresses exhaust the heap and take the process down. Evicting *soonest-to-expire*
   * first means the counters discarded are the ones with the least remaining protective value.
   */
  private makeRoom(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
    if (this.entries.size < this.maxKeys) return;

    const byExpiry = [...this.entries.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    const toEvict = this.entries.size - this.maxKeys + 1;
    for (let i = 0; i < toEvict; i += 1) {
      this.entries.delete(byExpiry[i][0]);
    }
  }
}

/**
 * The store used when `REDIS_URL` is configured but no client library can be loaded.
 *
 * Every call rejects. See this file's header for why that is the right answer rather than a
 * quiet fallback to {@link MemoryThrottleStore}.
 */
export class UnavailableThrottleStore implements ThrottleStore {
  readonly kind = 'unavailable' as const;

  constructor(private readonly reason: string) {}

  async consume(): Promise<ThrottleCounter> {
    throw new ThrottleStoreUnavailableError(this.reason);
  }
}

/**
 * The three commands this store needs. Deliberately tiny: it is the subset every Redis client
 * for Node implements identically, so `ioredis`, `redis` and a test double are interchangeable
 * without an adapter each.
 */
export interface RedisThrottleClient {
  incr(key: string): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<unknown>;
  pttl(key: string): Promise<number>;
}

/** Shared counters. Any rejection propagates to the guard, which applies the route's policy. */
export class RedisThrottleStore implements ThrottleStore {
  readonly kind = 'redis' as const;

  constructor(private readonly client: RedisThrottleClient) {}

  /**
   * `INCR`, then `PEXPIRE` on the first hit of a window.
   *
   * The `ttl < 0` branch is not defensive padding. `INCR` creates a key with **no** expiry; if
   * the process dies between the `INCR` and the `PEXPIRE`, or the `PEXPIRE` fails, that key
   * lives forever — and since it is already at or above the limit, the effect is a permanent
   * ban on whatever it keys (an email, an IP, a session). Re-arming the expiry whenever Redis
   * reports "no TTL" turns that from an unrecoverable lockout into a longer-than-intended
   * window.
   */
  async consume(key: string, windowMs: number, now: number): Promise<ThrottleCounter> {
    const count = await this.client.incr(key);

    if (count === 1) {
      await this.client.pexpire(key, windowMs);
      return { count, resetAt: now + windowMs };
    }

    const ttl = await this.client.pttl(key);
    if (ttl < 0) {
      await this.client.pexpire(key, windowMs);
      return { count, resetAt: now + windowMs };
    }

    return { count, resetAt: now + ttl };
  }
}

/** Constructs a client from a connection URL. Injectable so the loader is testable. */
export type RedisClientFactory = (url: string) => RedisThrottleClient;

type RedisConstructor = new (url: string) => RedisThrottleClient;

/**
 * Resolves a Redis constructor from a required module, tolerating both module shapes
 * (`module.exports = Redis` and `exports.default = Redis`).
 *
 * Exported for its own tests: the loader below cannot be exercised in this workspace, because
 * no Redis client is installed, and an untested resolver is exactly the kind of code that turns
 * out to be wrong the first time somebody adds one.
 */
export function resolveRedisConstructor(module: unknown): RedisConstructor | null {
  const candidate =
    typeof module === 'object' &&
    module !== null &&
    typeof (module as { default?: unknown }).default === 'function'
      ? (module as { default: unknown }).default
      : module;

  return typeof candidate === 'function' ? (candidate as RedisConstructor) : null;
}

/**
 * The default client factory: loads `ioredis` at runtime if it is installed.
 *
 * A runtime `require` rather than a static import because `ioredis` is *not* a dependency of
 * this workspace — a static import would fail the build everywhere, including in the
 * single-instance deployments that legitimately need no Redis at all. `createRequire` is used
 * in preference to a bare `require` so this stays honest under both module systems and does not
 * need a lint suppression.
 *
 * `load` is a parameter, defaulted, purely so both of its outcomes are testable in a workspace
 * where `ioredis` is by definition absent. An untested loader is how "we support Redis" becomes
 * "we crash on the first deployment that configures Redis".
 */
export function defaultRedisClientFactory(
  url: string,
  load: (id: string) => unknown = createRequire(__filename),
): RedisThrottleClient {
  const constructor = resolveRedisConstructor(load('ioredis'));
  if (constructor === null) {
    throw new ThrottleStoreUnavailableError('ioredis did not export a constructor.');
  }
  return new constructor(url);
}

export interface ThrottleStoreOptions {
  readonly redisUrl: string | undefined;
  readonly instanceCount: number;
  /** Overridden in tests; defaults to {@link defaultRedisClientFactory}. */
  readonly clientFactory?: RedisClientFactory;
  readonly logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
}

/**
 * Chooses the store, and says so at boot — loudly when the choice is a weakening.
 *
 * The `APP_INSTANCE_COUNT > 1` warning (T-012 implementation note 5) is the one message here
 * that an operator must never see in production and will only ever see because of a
 * misconfiguration, so it names the consequence rather than the setting.
 */
export function createThrottleStore(options: ThrottleStoreOptions): ThrottleStore {
  const logger = options.logger ?? new Logger('ThrottleStore');
  const url = options.redisUrl?.trim() ?? '';

  if (url.length === 0) {
    if (options.instanceCount > 1) {
      logger.warn(THROTTLE_MULTI_INSTANCE_WARNING);
    }
    logger.log('Rate limiting is using the in-memory counter store.');
    return new MemoryThrottleStore();
  }

  const factory = options.clientFactory ?? defaultRedisClientFactory;
  try {
    const store = new RedisThrottleStore(factory(url));
    logger.log('Rate limiting is using the Redis counter store.');
    return store;
  } catch (error) {
    const reason = `REDIS_URL is set but no Redis client could be created: ${
      (error as Error).message
    }`;
    // Not `warn`. A configured-but-unusable shared store means the login path is now shedding
    // load with 503s — an operator needs to see this at error level, immediately.
    logger.error(
      `${reason} Auth routes will fail closed (503) until this is fixed; general API traffic ` +
        'is unthrottled (02-SECURITY.md §8, AR-11).',
    );
    return new UnavailableThrottleStore(reason);
  }
}
