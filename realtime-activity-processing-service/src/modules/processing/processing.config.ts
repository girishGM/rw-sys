/**
 * T-RAP-030. DI tokens, safe defaults and the `service_config` resolution helper this module's
 * worker/sweep tunables share — same `Symbol` token + hardcoded-default convention
 * `invalidation.config.ts` (T-RAP-011) already established for this project.
 *
 * **Why these three knobs go through `ServiceConfigResolverService` (T-RAP-013), unlike
 * `invalidation.config.ts`'s own hardcoded values**: that file's own header explains it took a
 * hardcoded default specifically because `ServiceConfigResolver` did not exist yet at the time
 * (its own Scope note: "take a hardcoded 300s default if T-RAP-013 isn't done yet"). T-RAP-013 is
 * `done` as of this task (`progress.json`), and this task's own implementation notes name the
 * resolver directly ("poll interval when the queue is empty, concurrency limit per instance —
 * both resolved via T-RAP-013's `ServiceConfigResolver`"), so `resolvePositiveIntConfig` below
 * reads through it, live, on every cycle (cheap — an in-memory map lookup, per the resolver's own
 * header) rather than freezing a value at startup.
 *
 * **The un-seeded-key gap, disclosed rather than silently worked around**: `01-DATABASE.md` §11
 * lists only four `service_config` keys as seeded by T-RAP-003. The three keys this module reads
 * (`activity_log_claim_poll_interval_ms`, `activity_log_claim_concurrency`,
 * `processing_stale_timeout_seconds` — the last one this task's own implementation note 3 names
 * explicitly) are not among them, and the seed file that would add them
 * (`src/database/seeds/seed-data.constants.ts`) is outside this task's file scope (owned by
 * T-RAP-003/agent-rap-foundation, not `src/modules/processing/**`). Rather than hard-failing
 * `ActivityLogClaimWorker`/`StaleProcessingSweepService` startup on a fresh/un-seeded database
 * (`ServiceConfigResolverService.resolve()` throws for an unconfigured key, by design — see that
 * file's own header), `resolvePositiveIntConfig` catches exactly that case and falls back to the
 * `DEFAULT_*` constant below, logging once so the gap stays visible rather than silent. See this
 * task's own completion report for the follow-up (permanently seeding these three keys) filed for
 * the seed file's own owner.
 *
 * **T-RAP-031 addition**: `DEFAULT_ADVISORY_LOCK_WAIT_TIMEOUT_MS`/`AdvisoryLockTimeoutResolver`
 * below back `advisory-lock.util.ts`'s own `waitTimeoutMs` — this key (`advisory_lock_wait_timeout_ms`)
 * *is* seeded by T-RAP-003, unlike the three above, but the same "resolver unavailable/unseeded in
 * a test context" fallback discipline still applies rather than letting that case crash a claim.
 */
import type { Logger } from '@nestjs/common';
import type {
  ServiceConfigContext,
  ServiceConfigResolverService,
} from '@/modules/service-config/service-config-resolver.service';

/** The generic `resolve()` surface this module actually needs — a structural (not nominal) type
 * so tests can pass a lightweight fake without extending the real class, same discipline
 * `reconciliation-poller.service.spec.ts`'s own `FakeCampaignConfigClient` uses for its sibling
 * dependency. */
export type ConfigResolver = Pick<ServiceConfigResolverService, 'resolve'>;

/** The one typed method `RuleEvaluationRowHandler` actually needs off `ServiceConfigResolverService`
 * — same narrow-structural-type discipline as `ConfigResolver` above. */
export type AdvisoryLockTimeoutResolver = Pick<
  ServiceConfigResolverService,
  'getAdvisoryLockWaitTimeoutMs'
>;

export const PROCESSING_SERVICE_CONFIG_KEYS = {
  /** Milliseconds `ActivityLogClaimWorker` waits before its next claim attempt once a lane finds
   * the queue empty (05-PROCESSING-PIPELINE.md §4, this task's own Scope "poll interval when the
   * queue is empty"). */
  CLAIM_POLL_INTERVAL_MS: 'activity_log_claim_poll_interval_ms',
  /** How many claim lanes run concurrently within one process instance (this task's own Scope
   * "concurrency limit per instance"). */
  CLAIM_CONCURRENCY: 'activity_log_claim_concurrency',
  /** Seconds a row may sit in `processing` before `StaleProcessingSweepService` reclaims it back
   * to `pending` (this task's own implementation note 3, exact key name as specified there). */
  STALE_TIMEOUT_SECONDS: 'processing_stale_timeout_seconds',
} as const;

/** 1s — fast enough that an idle demo/dev instance still drains a freshly-inserted row promptly,
 * slow enough not to busy-spin the DB with empty claim queries (TC-3). */
export const DEFAULT_CLAIM_POLL_INTERVAL_MS = 1000;
/** 4 lanes — enough to show real intra-process concurrency (TC-1) without needing per-deployment
 * tuning to be usable out of the box. */
export const DEFAULT_CLAIM_CONCURRENCY = 4;
/** 300s / 5 minutes — matches this project's own existing "five minutes" convention for a
 * liveness-style safety-net interval (`DEFAULT_RECONCILIATION_POLL_INTERVAL_MS`, T-RAP-011). */
export const DEFAULT_STALE_TIMEOUT_SECONDS = 300;
/** How often `StaleProcessingSweepService` itself runs a sweep cycle. Not a named
 * `service_config` key in any design doc — this is the sweep's own scheduling cadence, not a
 * business-meaningful knob, so it follows `invalidation.config.ts`'s plain-hardcoded-default
 * convention directly rather than a resolver round trip. */
export const DEFAULT_STALE_SWEEP_INTERVAL_MS = 30_000;
/** 5000ms — matches the real seeded value (`01-DATABASE.md` §11 / `seed-data.constants.ts`'s own
 * `advisory_lock_wait_timeout_ms` row) so a resolver-unavailable fallback behaves identically to
 * the normal, seeded path in every environment that actually ran T-RAP-003's seed. */
export const DEFAULT_ADVISORY_LOCK_WAIT_TIMEOUT_MS = 5000;

/** Whether `ActivityLogClaimWorker.onModuleInit` actually starts its claim lanes, and
 * `StaleProcessingSweepService.onModuleInit` actually starts its own sweep interval. Same
 * rationale as `RECONCILIATION_POLLER_AUTOSTART` (T-RAP-011): this module is not wired into
 * `AppModule` by this task (nothing transport-facing/handler-providing exists yet — T-RAP-031
 * onward), so this mostly matters for tests, which construct the services directly and almost
 * always want `false` here to drive cycles deterministically instead of racing a real timer. */
export const CLAIM_WORKER_AUTOSTART = Symbol('CLAIM_WORKER_AUTOSTART');
export const STALE_SWEEP_AUTOSTART = Symbol('STALE_SWEEP_AUTOSTART');
/** DI token for `StaleProcessingSweepService`'s own sweep cadence (`DEFAULT_STALE_SWEEP_INTERVAL_MS`
 * above) — plain `Symbol` + hardcoded default, same convention as `CLAIM_WORKER_AUTOSTART`. */
export const STALE_SWEEP_INTERVAL_MS = Symbol('STALE_SWEEP_INTERVAL_MS');

/**
 * Resolves a positive-integer `service_config` value, falling back to `fallback` (logged once per
 * call site's caller, not spammed on every poll cycle — callers are expected to only log the
 * first occurrence themselves if they care; this helper logs at `warn` every time it falls back,
 * matching `ServiceConfigResolverService`'s own "fail loudly, name the offending row" discipline
 * applied to the "no row at all" case instead of the "malformed row" case it already covers).
 *
 * Deliberately duplicates (in miniature) `ServiceConfigResolverService.resolvePositiveInt`'s own
 * validation rather than depending on that `private` method — this module cannot reach it, and
 * doesn't need the full richness (the offending-row detail) since the fallback path already names
 * the key and the value it rejected.
 */
export function resolvePositiveIntConfig(
  resolver: ConfigResolver,
  configKey: string,
  context: ServiceConfigContext,
  fallback: number,
  logger: Logger,
): number {
  let raw: string;
  try {
    raw = resolver.resolve(configKey, context);
  } catch {
    logger.warn(
      `service_config key "${configKey}" is not seeded for this context; using default ${fallback}.`,
    );
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    logger.warn(
      `service_config key "${configKey}" has an invalid value (${JSON.stringify(raw)}); ` +
        `expected a positive integer, using default ${fallback}.`,
    );
    return fallback;
  }
  return parsed;
}

/**
 * `advisory-lock.util.ts`'s own `waitTimeoutMs` — same "resolver unavailable/unseeded falls back
 * loudly rather than crashing a claim" discipline as `resolvePositiveIntConfig` above, but reads
 * through `ServiceConfigResolverService.getAdvisoryLockWaitTimeoutMs` directly (already validates
 * "positive integer" itself) rather than the generic `resolve()` + re-validate pair.
 */
export function resolveAdvisoryLockWaitTimeoutMs(
  resolver: AdvisoryLockTimeoutResolver,
  context: ServiceConfigContext,
  logger: Logger,
): number {
  try {
    return resolver.getAdvisoryLockWaitTimeoutMs(context);
  } catch {
    logger.warn(
      `service_config key "advisory_lock_wait_timeout_ms" is not seeded for this context; using ` +
        `default ${DEFAULT_ADVISORY_LOCK_WAIT_TIMEOUT_MS}.`,
    );
    return DEFAULT_ADVISORY_LOCK_WAIT_TIMEOUT_MS;
  }
}
