/**
 * T-RR-040. `MetricsRegistry` — the exact counter contract `07-CONFIGURABILITY-AND-OBSERVABILITY.md`
 * §3 lists, fixed by name and label shape now so a later dashboard/alerting integration is additive,
 * never a rename. Mirrors RAP's own `src/observability/metrics.service.ts`
 * (`realtime-activity-processing-service`, confirmed by direct read) — the identical "plain
 * in-memory `Map`, not `prom-client`" choice, for the identical reason: adding a runtime dependency
 * means editing `package.json`, `agent-rr-foundation`'s exclusive file scope, not this task's
 * (`AGENT-PROTOCOL.md` R10/R3).
 *
 * One method per §3 metric, each with exactly the label set that section specifies — never a
 * free-form label bag, so a typo in a label name is a compile error at the call site, not a
 * silently-wrong series name.
 *
 * **Two of these seven (`reward_tracking_dispatch_tier_total`, `notification_logged_total`) already
 * have a real, correctly-wired call site today** — `DispatchMetricsService`
 * (`src/modules/dispatch/dispatch-metrics.service.ts`, T-RR-034/T-RR-035) and
 * `NotificationMetricsService` (`src/modules/notification/notification-metrics.service.ts`,
 * T-RR-036), each an in-memory placeholder built explicitly anticipating this task (see their own
 * headers). Those files are `agent-rr-integration`'s exclusive scope (R3), not this task's, so this
 * registry does not replace them — it exposes the identical name/label contract for the other five
 * metrics that (per this task's own audit, recorded in its completion report) have no call site at
 * all yet, and stands ready for `agent-rr-integration` to delegate those two placeholders' internals
 * to this registry in a future pass, at its own discretion, without any name/label change on either
 * side.
 */
import { Injectable } from '@nestjs/common';

/** `07-CONFIGURABILITY-AND-OBSERVABILITY.md` §3's three inbound ingestion channels. */
export type IngestionChannel = 'grpc' | 'kafka' | 'rest';

/** §3's three `external_system_call_total` result values — matches
 * `08-EXTERNAL-INTEGRATION-CONTRACTS.md`/`RedemptionResult`'s own three outcomes, lower-cased and
 * snake_cased for the metric label. */
export type ExternalCallResult = 'success' | 'retryable_failure' | 'permanent_failure';

/** §3's three `reward_tracking_dispatch_tier_total` tier values (`ARCHITECTURE.md` §9). */
export type DispatchTier = 'kafka' | 'rest' | 'retry_table';

function labelKey(name: string, labels: Readonly<Record<string, string>>): string {
  const labelPart = Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(',');
  return labelPart.length > 0 ? `${name}{${labelPart}}` : name;
}

@Injectable()
export class MetricsRegistry {
  private readonly counters = new Map<string, number>();

  /** `reward_entries_ingested_total{channel}` — one inbound entry durably received, before any
   * processing (`ARCHITECTURE.md` §6). Call once per `ingest()` call that reaches a durable
   * outcome (a fresh insert or a short-circuited duplicate), regardless of channel. */
  incrementRewardEntriesIngested(channel: IngestionChannel): void {
    this.incrementCounter('reward_entries_ingested_total', { channel });
  }

  /** `reward_redemptions_completed_total{system_code}` — an entry reached `status = 'completed'`
   * (`05-PROCESSING-PIPELINE.md` §2), including the direct no-external-call path. */
  incrementRewardRedemptionsCompleted(systemCode: string): void {
    this.incrementCounter('reward_redemptions_completed_total', { system_code: systemCode });
  }

  /** `reward_redemptions_failed_total{system_code}` — an entry reached `status = 'failed'`
   * (`05-PROCESSING-PIPELINE.md` §7). */
  incrementRewardRedemptionsFailed(systemCode: string): void {
    this.incrementCounter('reward_redemptions_failed_total', { system_code: systemCode });
  }

  /** `external_system_call_total{system_code, result}` — one connector call attempt and its
   * classification (`05-PROCESSING-PIPELINE.md` §5), one increment per `external_system_call_log`
   * row (`01-DATABASE.md` §9). */
  incrementExternalSystemCall(systemCode: string, result: ExternalCallResult): void {
    this.incrementCounter('external_system_call_total', { system_code: systemCode, result });
  }

  /** `reward_tracking_dispatch_tier_total{tier}` — which channel actually delivered (or attempted
   * to deliver) a `reward_tracking_dispatch_outbox` row (`ARCHITECTURE.md` §9). */
  incrementRewardTrackingDispatchTier(tier: DispatchTier): void {
    this.incrementCounter('reward_tracking_dispatch_tier_total', { tier });
  }

  /** `notification_logged_total` (no labels) — a `notification_log` row was written
   * (`05-PROCESSING-PIPELINE.md` §6 step 4). Call only once per row actually written, never on a
   * skip. */
  incrementNotificationLogged(): void {
    this.incrementCounter('notification_logged_total', {});
  }

  /** `cache_invalidation_total{key}` — one `POST /api/v1/cache/invalidate` call processed
   * (`06-CACHING-AND-TENANT-CONFIG.md` §3). `key` is one of the five cache names that section lists,
   * or the literal string `'all'` for a whole-registry clear. */
  incrementCacheInvalidation(key: string): void {
    this.incrementCounter('cache_invalidation_total', { key });
  }

  /** Current counter value for `name`/`labels` — `0` if never incremented, never `undefined`, so a
   * test/future exporter never has to null-check before comparing against an expected count. */
  getCounterValue(name: string, labels: Readonly<Record<string, string>> = {}): number {
    return this.counters.get(labelKey(name, labels)) ?? 0;
  }

  /** Test-only reset of all in-memory metric state. Never called from a production code path —
   * this service is a process-lifetime singleton in every real deployment. */
  resetForTests(): void {
    this.counters.clear();
  }

  private incrementCounter(name: string, labels: Readonly<Record<string, string>>, by = 1): void {
    const key = labelKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }
}
