/**
 * T-PC-022. DI tokens + safe defaults for the outbox publisher worker's tunables
 * (implementation note 6: "Poll interval and batch size are configurable, not hardcoded" — this
 * directly affects T-PC-043's later load-test numbers). Same convention
 * `promo-code-generation.constants.ts` (T-PC-021) already established: a `Symbol` DI token per
 * tunable, read from `ConfigService` in `outbox-publisher.module.ts` **without** extending
 * `src/config/config.schema.ts`'s required-env Zod schema (outside this task's file scope, R8) —
 * each of these is an optional tuning knob with a documented safe default, not a required
 * secret/connection string that must crash boot when absent.
 */

/** How often the poller runs a poll cycle. Default kept conservative (implementation note 6). */
export const OUTBOX_POLL_INTERVAL_MS = Symbol('OUTBOX_POLL_INTERVAL_MS');
export const DEFAULT_OUTBOX_POLL_INTERVAL_MS = 500;

/** Max `PENDING` rows fetched per poll cycle (TC-4/TC-12). */
export const OUTBOX_BATCH_SIZE = Symbol('OUTBOX_BATCH_SIZE');
export const DEFAULT_OUTBOX_BATCH_SIZE = 20;

/**
 * Ceiling on `attempts` before a row is marked `FAILED` (implementation note 3 — "do not retry a
 * genuinely poison payload forever").
 */
export const OUTBOX_MAX_ATTEMPTS = Symbol('OUTBOX_MAX_ATTEMPTS');
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;

/** Base delay for the exponential backoff between retries on the same row. */
export const OUTBOX_BACKOFF_BASE_MS = Symbol('OUTBOX_BACKOFF_BASE_MS');
export const DEFAULT_OUTBOX_BACKOFF_BASE_MS = 200;

/** Upper bound the exponential backoff is clamped to, however many attempts have accumulated. */
export const OUTBOX_BACKOFF_MAX_MS = Symbol('OUTBOX_BACKOFF_MAX_MS');
export const DEFAULT_OUTBOX_BACKOFF_MAX_MS = 30_000;

/** `02-KAFKA-CONTRACTS.md` §2's envelope `source` field for every message this service produces. */
export const OUTBOX_EVENT_SOURCE = 'promo-code-service';

/**
 * Whether `OutboxPublisherWorker.onModuleInit` actually starts its own `setInterval` poller —
 * the Rollback section's own "config flag to disable it" ("`promo_code_outbox` rows simply
 * accumulate as `PENDING`... restarting the worker later drains the backlog"). Resolved in
 * `outbox-publisher.module.ts`, defaulting to `NODE_ENV !== 'test'` when unset: every
 * `*.e2e-spec.ts` in this project boots the full `AppModule` for reasons that have nothing to do
 * with the outbox (health, config CRUD, binding, generation), and a live poller racing a real,
 * global, un-scoped `promo_code_outbox` query against whatever rows those *other* suites happen
 * to create (`test/modules/generation/promo-code-generation.service.spec.ts`'s own KAFKA-transport
 * TC-7, for one) would be exactly the kind of cross-test, cross-process nondeterminism
 * `AGENT-PROTOCOL.md` warns against introducing. This task's own test suite never relies on this
 * auto-start path — it drives `OutboxPublisherWorker.runOnce()` directly — so disabling it under
 * `NODE_ENV=test` costs that suite nothing while keeping real dev/production behavior unchanged
 * (enabled by default there).
 */
export const OUTBOX_PUBLISHER_AUTOSTART = Symbol('OUTBOX_PUBLISHER_AUTOSTART');
