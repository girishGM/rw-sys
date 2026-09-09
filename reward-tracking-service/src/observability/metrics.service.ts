/**
 * T-RTS-040. `MetricsService` — the exact counter contract this task's own Scope lists
 * (`AGENT-PROTOCOL.md` §"Scope" of `T-RTS-040-observability-wiring.md`):
 *
 * - `reward_tracking_events_ingested_total{channel,outcome}` — `channel` matches
 *   `InboundEventChannel` (`src/database/models/inbound-event-log.model.ts`, `'GRPC'|'KAFKA'|'REST'`),
 *   `outcome` matches the subset of `InboundEventProcessingStatus` a completed ingestion attempt can
 *   end in (`'applied'|'duplicate'|'failed'` — never `'received'`, which is a transient pre-outcome
 *   state, never observed as a final metric).
 * - `reward_tracking_shard_write_total{campaign_code}` — one increment per successful
 *   `campaign_reward_counter_shard` write (R7's own atomic `UPDATE ... SET x = x + $delta`).
 * - `reward_tracking_api_requests_total{endpoint,status}` — one increment per customer/admin API
 *   response, `endpoint` the route path template (never the raw path with interpolated ids, so the
 *   series count stays bounded), `status` the HTTP status code as a string label value.
 *
 * **Backend is a plain in-memory map, not `prom-client` or any other external dependency** — the
 * exact same choice `realtime-activity-processing-service`'s own `T-RAP-043`
 * (`src/observability/metrics.service.ts`) already made, for the same reason: adding a new runtime
 * dependency means editing `package.json`, which is `agent-rts-foundation`'s exclusive file scope,
 * not this task's (`AGENT-PROTOCOL.md` R10, R9 — no workaround smuggled around a scope boundary).
 * One counter method per contract metric above, each with exactly the label set specified — never a
 * free-form label bag, so a typo in a label name is a compile error at the call site, not a
 * silently-wrong series name (append-only once shipped, per this task's own "Out" scope).
 *
 * **No dedicated `/metrics` HTTP endpoint exists anywhere in this plan.** Confirmed by grepping
 * every task file and every `brain-storm/*.md` design doc before writing this file — this task's
 * own Verification step 2 ("Hit `/metrics` after a few ingestions") is the *only* place `/metrics`
 * is mentioned at all, and registering an actual HTTP route would require editing
 * `src/app.module.ts`/`src/health/**`, both `agent-rts-foundation`'s exclusive scope (R10), or
 * adding a brand-new controller nowhere named in this task's "Files owned" list. `getCounterValue`
 * below is this task's own "available" half of "counters present and correct" — a future exporter
 * (an HTTP `/metrics` route, a StatsD bridge, whatever a dashboard integration needs) reads through
 * this method, and this task's own test suite exercises the identical surface. This mirrors
 * `T-RAP-043`'s own precedent, forced by an identical file-scope constraint, and is flagged as a
 * deviation in this task's completion report rather than silently reinterpreted.
 *
 * **Real call-site wiring is out of this task's file scope.** The actual `applyRewardTrackingEvent`/
 * transport-adapter/API-controller call sites that would invoke these increment methods in
 * production live in `src/modules/ingestion/**`, `src/grpc/**`, `src/kafka/**`, `src/modules/api/**`
 * — all owned by `agent-rts-ingestion`/`agent-rts-api` (R10). See this task's own completion report
 * for the defects filed against those owners so the wiring itself is scheduled, not silently
 * skipped.
 */
import { Injectable } from '@nestjs/common';
import type { InboundEventChannel } from '@/database/models/inbound-event-log.model';

/** `InboundEventProcessingStatus` minus `'received'` — the only three values an ingestion attempt
 * can be *finally* observed to end in (`inbound-event-log.model.ts`'s own type). */
export type IngestOutcome = 'applied' | 'duplicate' | 'failed';

/** Re-exported under this module's own name so a call site never has to reach into
 * `src/database/models/**` just to label a metric correctly. */
export type IngestChannel = InboundEventChannel;

function labelKey(name: string, labels: Readonly<Record<string, string>>): string {
  const labelPart = Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(',');
  return labelPart.length > 0 ? `${name}{${labelPart}}` : name;
}

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();

  // ---- reward_tracking_events_ingested_total{channel,outcome} --------------------------------
  incrementEventsIngested(channel: IngestChannel, outcome: IngestOutcome): void {
    this.incrementCounter('reward_tracking_events_ingested_total', { channel, outcome });
  }

  // ---- reward_tracking_shard_write_total{campaign_code} --------------------------------------
  incrementShardWrite(campaignCode: string): void {
    this.incrementCounter('reward_tracking_shard_write_total', { campaign_code: campaignCode });
  }

  // ---- reward_tracking_api_requests_total{endpoint,status} ------------------------------------
  incrementApiRequest(endpoint: string, status: number | string): void {
    this.incrementCounter('reward_tracking_api_requests_total', {
      endpoint,
      status: String(status),
    });
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
