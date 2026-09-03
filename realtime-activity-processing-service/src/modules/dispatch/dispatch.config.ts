/**
 * T-RAP-034. DI tokens + safe defaults for the three dispatch-tier workers
 * (`outbox-publisher.service.ts`, `reward-dispatch-retry.worker.ts`) — same `Symbol` token +
 * hardcoded-default + `service_config`-resolved-with-fallback convention `processing.config.ts`
 * (T-RAP-030/031) already established for this project.
 *
 * `REWARD_DISPATCH_MAX_RETRY_ATTEMPTS` (`service_config`, seeded by T-RAP-003, resolved through
 * `ServiceConfigResolverService.getRewardDispatchMaxRetryAttempts`, T-RAP-013) is the **one**
 * config knob `05-PROCESSING-PIPELINE.md` §7 actually names, and it governs **two** distinct
 * decisions in this task's own three-tier chain (no second key is seeded for the other one —
 * `01-DATABASE.md` §11 lists only four `service_config` keys in total, and this is the only
 * dispatch-shaped one among them):
 *  - `OutboxPublisherService`: how many failed Kafka attempts (`reward_entry_outbox.attempts`) on
 *    the *same* row before it switches to the gRPC fallback tier instead (implementation note 3:
 *    "after a configurable number of failed publish attempts ... on the same outbox row").
 *  - `RewardDispatchRetryWorker`: how many attempts (`kafka_attempts + grpc_attempts` combined,
 *    this task's own reading — `01-DATABASE.md` §9 tracks the two counters separately but names
 *    one shared "attempt cap" in its own prose) a `reward_dispatch_retry` row gets before flipping
 *    to `exhausted` (implementation note 4).
 */
import type { Logger } from '@nestjs/common';
import type { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';

/** The one typed method this module actually needs off `ServiceConfigResolverService` — same
 * narrow-structural-type discipline `processing.config.ts`'s own `AdvisoryLockTimeoutResolver`
 * already established, so tests can pass a lightweight fake without extending the real class. */
export type RewardDispatchMaxRetryResolver = Pick<
  ServiceConfigResolverService,
  'getRewardDispatchMaxRetryAttempts'
>;

/** 8 — matches the real seeded value (`service-config-resolver.service.ts`'s own doc comment:
 * "Default seeded by T-RAP-003: 8 (global)") so a resolver-unavailable/unseeded fallback behaves
 * identically to the normal, seeded path in every environment that actually ran T-RAP-003's seed. */
export const DEFAULT_REWARD_DISPATCH_MAX_RETRY_ATTEMPTS = 8;

/** Same "resolver unavailable/unseeded falls back loudly rather than crashing a dispatch attempt"
 * discipline as `processing.config.ts`'s own `resolveAdvisoryLockWaitTimeoutMs`. */
export function resolveRewardDispatchMaxRetryAttempts(
  resolver: RewardDispatchMaxRetryResolver,
  logger: Logger,
): number {
  try {
    return resolver.getRewardDispatchMaxRetryAttempts({});
  } catch {
    logger.warn(
      'service_config key "reward_dispatch_max_retry_attempts" is not seeded for this context; ' +
        `using default ${DEFAULT_REWARD_DISPATCH_MAX_RETRY_ATTEMPTS}.`,
    );
    return DEFAULT_REWARD_DISPATCH_MAX_RETRY_ATTEMPTS;
  }
}

/** How often `OutboxPublisherService`/`RewardDispatchRetryWorker` each run a poll cycle — not a
 * named `service_config` key in any design doc (same reasoning `DEFAULT_STALE_SWEEP_INTERVAL_MS`
 * gives for its own sibling): this is scheduling cadence, not a business-meaningful knob. */
export const DEFAULT_OUTBOX_POLL_INTERVAL_MS = 500;
export const DEFAULT_RETRY_WORKER_POLL_INTERVAL_MS = 2000;
/** Max `PENDING`/due rows fetched per poll cycle. */
export const DEFAULT_OUTBOX_BATCH_SIZE = 20;
export const DEFAULT_RETRY_BATCH_SIZE = 20;
/** Base/max exponential backoff between two `reward_dispatch_retry` attempts on the same row,
 * applied to `next_retry_at` (`01-DATABASE.md` §9). */
export const DEFAULT_RETRY_BACKOFF_BASE_MS = 1000;
export const DEFAULT_RETRY_BACKOFF_MAX_MS = 5 * 60 * 1000;

export const OUTBOX_POLL_INTERVAL_MS = Symbol('OUTBOX_POLL_INTERVAL_MS');
export const OUTBOX_BATCH_SIZE = Symbol('OUTBOX_BATCH_SIZE');
export const RETRY_WORKER_POLL_INTERVAL_MS = Symbol('RETRY_WORKER_POLL_INTERVAL_MS');
export const RETRY_BATCH_SIZE = Symbol('RETRY_BATCH_SIZE');
export const RETRY_BACKOFF_BASE_MS = Symbol('RETRY_BACKOFF_BASE_MS');
export const RETRY_BACKOFF_MAX_MS = Symbol('RETRY_BACKOFF_MAX_MS');

/** Whether `OutboxPublisherService`/`RewardDispatchRetryWorker`'s own `onModuleInit` actually
 * starts their `setInterval` pollers — same rationale as `STALE_SWEEP_AUTOSTART`/
 * `OUTBOX_PUBLISHER_AUTOSTART` (`promo-code-service`'s own precedent): this module is not wired
 * into `AppModule` by this task, so this mostly matters for tests, which construct the services
 * directly and almost always want `false` to drive cycles deterministically instead of racing a
 * real timer. */
export const OUTBOX_PUBLISHER_AUTOSTART = Symbol('OUTBOX_PUBLISHER_AUTOSTART');
export const RETRY_WORKER_AUTOSTART = Symbol('RETRY_WORKER_AUTOSTART');
