/**
 * T-RAP-011. DI tokens + safe defaults for this module's own tunables — same convention
 * `promo-code-service`'s `outbox-publisher.config.ts` already established (a `Symbol` token per
 * tunable, resolved in `invalidation.module.ts` via `ConfigService.get` without `{ infer: true }`,
 * outside `src/config/config.schema.ts`'s required-env Zod schema — each of these is an optional
 * tuning knob with a documented safe default, not a required secret, R8).
 *
 * **`RECONCILIATION_POLL_INTERVAL_MS`**: `04-CACHE-INVALIDATION.md` §3 names the real backing key
 * as `service_config.reconciliation_poll_interval_seconds` (`01-DATABASE.md` §11), owned by
 * T-RAP-013's `ServiceConfigResolver` — `pending` as of this task (`progress.json`). Per this
 * task's own Scope note ("take a hardcoded 300s default if T-RAP-013 isn't done yet, and note the
 * TODO"), `ReconciliationPollerService` reads a **plain, hardcoded default** here instead of a
 * resolver call.
 *
 * TODO(T-RAP-013): once `ServiceConfigResolver` lands, wire `ReconciliationPollerService`'s poll
 * interval through `service_config.reconciliation_poll_interval_seconds` instead of this hardcoded
 * default — replace the call site in `invalidation.module.ts`, not this constant itself (kept as
 * the env-var override / ultimate fallback either way).
 */

/** How often `ReconciliationPollerService` runs a full poll cycle across every configured tenant. */
export const RECONCILIATION_POLL_INTERVAL_MS = Symbol('RECONCILIATION_POLL_INTERVAL_MS');
/** 300s / 5 minutes — matches the portal's own documented cache TTL convention (§3), not picked
 * arbitrarily. */
export const DEFAULT_RECONCILIATION_POLL_INTERVAL_MS = 300_000;

/** Base delay for `WatchStreamConsumer`'s exponential backoff between reconnect attempts. */
export const WATCH_STREAM_BACKOFF_BASE_MS = Symbol('WATCH_STREAM_BACKOFF_BASE_MS');
export const DEFAULT_WATCH_STREAM_BACKOFF_BASE_MS = 500;

/** Upper bound the reconnect backoff is clamped to, however many attempts have accumulated. */
export const WATCH_STREAM_BACKOFF_MAX_MS = Symbol('WATCH_STREAM_BACKOFF_MAX_MS');
export const DEFAULT_WATCH_STREAM_BACKOFF_MAX_MS = 30_000;

/**
 * Whether `WatchStreamConsumer.onModuleInit` actually opens its streams, and
 * `ReconciliationPollerService.onModuleInit` actually runs its startup poll + starts its own
 * `setInterval`. Same rationale as `promo-code-service`'s `OUTBOX_PUBLISHER_AUTOSTART`: this
 * module is not imported into `AppModule` by this task (same convention `campaign-config-cache.
 * module.ts`'s own header already set — nothing transport-facing consumes it yet), so this mostly
 * matters for a future Wave-2+ task that does wire it in alongside other modules' own e2e specs;
 * kept here now so that wiring doesn't have to rediscover the same "don't race a live
 * stream/poller against a test's own real Postgres rows" problem. Defaults to
 * `NODE_ENV !== 'test'`.
 */
export const WATCH_STREAM_AUTOSTART = Symbol('WATCH_STREAM_AUTOSTART');
export const RECONCILIATION_POLLER_AUTOSTART = Symbol('RECONCILIATION_POLLER_AUTOSTART');
