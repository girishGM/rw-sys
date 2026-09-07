/**
 * T-RR-034. DI tokens + `service_config`-resolved-with-fallback helpers for
 * `OutboxPublisherService` — same "narrow structural `Pick<...>` type + resolve-with-a-logged-
 * default-on-`ServiceConfigNotFoundError`" convention RAP's own `dispatch.config.ts` already
 * established (`realtime-activity-processing-service/src/modules/dispatch/dispatch.config.ts`,
 * confirmed by direct read, per this task's own implementation note 1: "port RAP's own
 * `outbox-publisher.service.ts` shape").
 *
 * Both `service_config` keys named by this task's own implementation note 6
 * (`dispatch.outbox.pollIntervalSeconds`, `dispatch.kafka.attemptsBeforeFallback`) are expected to
 * be unseeded in every environment until T-RR-046 (Wave 4/5, not yet built) seeds a `GLOBAL`
 * default for every named `service_config` key across this plan's design docs — this is a known,
 * accepted gap (see that task's own scope), not a defect: `ServiceConfigResolverService.resolve()`
 * throws `ServiceConfigNotFoundError` on a genuinely unseeded key (by design, T-RR-006 — never a
 * silent `undefined`), so this file's own helpers below catch exactly that and fall back to a
 * hardcoded default with a one-time warn log, the same "unseeded/unavailable falls back loudly
 * rather than crashing a dispatch attempt" discipline RAP's own helper documents.
 *
 * **T-RR-035 extends this same file** (both tasks are `agent-rr-integration`'s own, and this
 * task's own scope note explicitly puts its tier-selection logic "inside (or alongside)
 * T-RR-034's `OutboxPublisherService` poll cycle" — same "extra file/export added when the
 * implementation genuinely needs it, inside this agent's own `dispatch/**` scope grant"
 * precedent this file's own `DispatchMetricsService`/`dispatch.module.ts` already establish) with
 * the `reward_tracking_dispatch_retry` worker's own config (`dispatch.retry.maxAttempts` plus its
 * own scheduling/backoff constants, below).
 */
import type { Logger } from '@nestjs/common';
import type { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';

/** The one typed method this module actually needs off `ServiceConfigResolverService` — same
 * narrow-structural-type discipline RAP's own `RewardDispatchMaxRetryResolver` established, so
 * tests can pass a lightweight fake without extending the real class. */
export type DispatchServiceConfigResolver = Pick<ServiceConfigResolverService, 'resolve'>;

/** How many failed Kafka publish attempts (`reward_tracking_dispatch_outbox.attempts`) a row may
 * accumulate before this poller stops attempting Kafka for it and leaves it for T-RR-035's REST
 * tier to pick up instead (implementation note 5/8). */
export const DEFAULT_KAFKA_ATTEMPTS_BEFORE_FALLBACK = 3;

/** How often `OutboxPublisherService` runs a poll cycle, in milliseconds. */
export const DEFAULT_OUTBOX_POLL_INTERVAL_MS = 5_000;

/** Max `PENDING` rows fetched per poll cycle. */
export const DEFAULT_OUTBOX_BATCH_SIZE = 20;

export const OUTBOX_BATCH_SIZE = Symbol('OUTBOX_BATCH_SIZE');

/** Whether `OutboxPublisherService`'s own `onModuleInit` actually starts its `setInterval` poller
 * — same rationale as RAP's own `OUTBOX_PUBLISHER_AUTOSTART`: this module is not wired into
 * `AppModule` by this task (see `dispatch.module.ts`'s own header), so this mostly matters for
 * tests, which construct the service directly and almost always want `false` to drive cycles
 * deterministically via `runOnce()` instead of racing a real timer. */
export const OUTBOX_PUBLISHER_AUTOSTART = Symbol('OUTBOX_PUBLISHER_AUTOSTART');

/**
 * `dispatch.kafka.attemptsBeforeFallback` (implementation note 6) — resolved fresh once per poll
 * cycle (`GLOBAL` scope only; this knob is not scoped per campaign/tracker/reward by any design
 * doc), never cached in-process, since `ServiceConfigResolverService` itself owns no cache
 * (T-RR-006's own note 5 — `06-CACHING-AND-TENANT-CONFIG.md`'s cache wrapper is a different,
 * cached resolver this task does not use here, matching RAP's own choice not to bother caching a
 * value read once per poll cycle rather than once per row).
 */
export async function resolveKafkaAttemptsBeforeFallback(
  resolver: DispatchServiceConfigResolver,
  logger: Logger,
): Promise<number> {
  try {
    return await resolver.resolve('dispatch.kafka.attemptsBeforeFallback', 'int');
  } catch {
    logger.warn(
      'service_config key "dispatch.kafka.attemptsBeforeFallback" is not seeded for this ' +
        `context (expected until T-RR-046 seeds it) — using default ${DEFAULT_KAFKA_ATTEMPTS_BEFORE_FALLBACK}.`,
    );
    return DEFAULT_KAFKA_ATTEMPTS_BEFORE_FALLBACK;
  }
}

/** `dispatch.outbox.pollIntervalSeconds` (implementation note 6), converted to milliseconds for
 * `setInterval`. Resolved once at `start()` time, not re-resolved every cycle — a poll cadence
 * change via `service_config` takes effect on this service's next restart, mirroring the fixed
 * (never-mid-flight-reconfigured) poll interval every prior interval-poll worker in this project
 * family (RAP's own `OUTBOX_POLL_INTERVAL_MS`) already establishes as a boot-time-fixed value. */
export async function resolveOutboxPollIntervalMs(
  resolver: DispatchServiceConfigResolver,
  logger: Logger,
): Promise<number> {
  try {
    const seconds = await resolver.resolve('dispatch.outbox.pollIntervalSeconds', 'int');
    return seconds * 1000;
  } catch {
    logger.warn(
      'service_config key "dispatch.outbox.pollIntervalSeconds" is not seeded for this context ' +
        `(expected until T-RR-046 seeds it) — using default ${DEFAULT_OUTBOX_POLL_INTERVAL_MS}ms.`,
    );
    return DEFAULT_OUTBOX_POLL_INTERVAL_MS;
  }
}

/**
 * T-RR-035. `dispatch.retry.maxAttempts` (`01-DATABASE.md` §7's own note, implementation note 5)
 * — the `reward_tracking_dispatch_retry` table's own attempt cap, a *different* retry budget from
 * `external_reward_system_config.max_retry_attempts` (§5's own "two distinct retry budgets exist
 * in this service, and they must not be conflated"). Same unseeded-until-T-RR-046,
 * fall-back-loudly discipline as the two `resolve*` helpers above.
 */
export const DEFAULT_DISPATCH_RETRY_MAX_ATTEMPTS = 5;

export async function resolveDispatchRetryMaxAttempts(
  resolver: DispatchServiceConfigResolver,
  logger: Logger,
): Promise<number> {
  try {
    return await resolver.resolve('dispatch.retry.maxAttempts', 'int');
  } catch {
    logger.warn(
      'service_config key "dispatch.retry.maxAttempts" is not seeded for this context (expected ' +
        `until T-RR-046 seeds it) — using default ${DEFAULT_DISPATCH_RETRY_MAX_ATTEMPTS}.`,
    );
    return DEFAULT_DISPATCH_RETRY_MAX_ATTEMPTS;
  }
}

/**
 * T-RR-035. `RewardTrackingDispatchRetryWorker`'s own scheduling/backoff constants — not a named
 * `service_config` key in any design doc (same reasoning `DEFAULT_OUTBOX_POLL_INTERVAL_MS` above
 * gives for its own sibling, and RAP's own `dispatch.config.ts` gives for
 * `DEFAULT_RETRY_WORKER_POLL_INTERVAL_MS`/`DEFAULT_RETRY_BACKOFF_BASE_MS`/`_MAX_MS`): this is
 * scheduling cadence, not a business-meaningful knob, so it is a boot-time-fixed constant,
 * DI-overridable only for tests — exactly RAP's own convention, ported here rather than
 * reinvented.
 */
export const DEFAULT_RETRY_WORKER_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_RETRY_BATCH_SIZE = 20;
export const DEFAULT_RETRY_BACKOFF_BASE_MS = 5_000;
export const DEFAULT_RETRY_BACKOFF_MAX_MS = 5 * 60 * 1000;

export const RETRY_WORKER_POLL_INTERVAL_MS = Symbol('RETRY_WORKER_POLL_INTERVAL_MS');
export const RETRY_BATCH_SIZE = Symbol('RETRY_BATCH_SIZE');
export const RETRY_BACKOFF_BASE_MS = Symbol('RETRY_BACKOFF_BASE_MS');
export const RETRY_BACKOFF_MAX_MS = Symbol('RETRY_BACKOFF_MAX_MS');
export const RETRY_WORKER_AUTOSTART = Symbol('RETRY_WORKER_AUTOSTART');
