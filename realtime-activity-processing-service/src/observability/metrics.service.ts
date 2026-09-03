/**
 * T-RAP-043. `MetricsService` — the exact counter/histogram contract
 * `06-CONFIGURABILITY-AND-OBSERVABILITY.md` §3 lists, so a future observability backend (deferred,
 * `BACKLOG.md` B-4/B-2) can rely on these names without re-deriving them: `activities_ingested_total
 * {transport}`, `activity_logs_fanout_total`, `tracker_components_completed_total{campaign_code}`,
 * `rewards_created_total{campaign_code,reward_category}`, `budget_breach_total{campaign_code,
 * cap_type}`, `dedup_hits_total`, `reward_dispatch_tier_total{tier}` and
 * `activity_processing_duration_seconds` (claim-to-`processed` latency, the number that
 * substantiates "fast to process realtime data").
 *
 * **Backend is deliberately a plain in-memory map, not `prom-client` or any other external
 * dependency** — this task's own spec ("exact backend left to T-RAP-043's own discretion") and the
 * fact that adding a new runtime dependency means editing `package.json`, which is
 * `agent-rap-foundation`'s exclusive file scope, not this task's (`AGENT-PROTOCOL.md` R10). One
 * counter/histogram method per contract metric below, each with exactly the label set
 * `06-CONFIGURABILITY-AND-OBSERVABILITY.md` §3 specifies — never a free-form label bag, so a typo
 * in a label name is a compile error at the call site, not a silently-wrong series name.
 *
 * `getCounterValue`/`getHistogramSnapshot` are this task's "available" half of "makes the data
 * correct and available" (§3): a future exporter (HTTP `/metrics` endpoint, StatsD bridge, whatever
 * dashboard tooling picks) reads through these, and this suite's own tests exercise the exact same
 * surface. Building that exporter itself is the explicitly deferred part (`BACKLOG.md` B-4/B-2, this
 * task's own Scope "Out").
 */
import { Injectable } from '@nestjs/common';

/** `03-GRPC-CONTRACT.md`/`02-KAFKA-CONTRACTS.md`'s two inbound transports. */
export type IngestTransport = 'grpc' | 'kafka';

/** `05-PROCESSING-PIPELINE.md` §7's three dispatch tiers, in the exact casing the design doc uses. */
export type RewardDispatchTier = 'kafka' | 'grpc' | 'retry_table';

export interface HistogramSnapshot {
  count: number;
  sum: number;
  values: readonly number[];
}

/** Pure helper — `elapsedSince(startMs)` in seconds, for callers that captured a claim timestamp
 * via `Date.now()` and want to feed `observeActivityProcessingDurationSeconds` without each call
 * site re-deriving the same `(Date.now() - startMs) / 1000` arithmetic. */
export function elapsedSeconds(startMs: number, endMs: number = Date.now()): number {
  return (endMs - startMs) / 1000;
}

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
  private readonly histogramSamples = new Map<string, number[]>();

  // ---- activities_ingested_total{transport} --------------------------------------------------
  incrementActivitiesIngested(transport: IngestTransport): void {
    this.incrementCounter('activities_ingested_total', { transport });
  }

  // ---- activity_logs_fanout_total (no labels — one increment per fan-out row actually inserted,
  // `05-PROCESSING-PIPELINE.md` §1 step 6) -----------------------------------------------------
  incrementActivityLogsFanout(insertedRowCount = 1): void {
    this.incrementCounter('activity_logs_fanout_total', {}, insertedRowCount);
  }

  // ---- tracker_components_completed_total{campaign_code} -------------------------------------
  incrementTrackerComponentsCompleted(campaignCode: string): void {
    this.incrementCounter('tracker_components_completed_total', { campaign_code: campaignCode });
  }

  // ---- rewards_created_total{campaign_code,reward_category} ----------------------------------
  incrementRewardsCreated(campaignCode: string, rewardCategory: string): void {
    this.incrementCounter('rewards_created_total', {
      campaign_code: campaignCode,
      reward_category: rewardCategory,
    });
  }

  // ---- budget_breach_total{campaign_code,cap_type} --------------------------------------------
  incrementBudgetBreach(campaignCode: string, capType: string): void {
    this.incrementCounter('budget_breach_total', {
      campaign_code: campaignCode,
      cap_type: capType,
    });
  }

  // ---- dedup_hits_total (no labels) ------------------------------------------------------------
  incrementDedupHits(): void {
    this.incrementCounter('dedup_hits_total', {});
  }

  // ---- reward_dispatch_tier_total{tier} --------------------------------------------------------
  incrementRewardDispatchTier(tier: RewardDispatchTier): void {
    this.incrementCounter('reward_dispatch_tier_total', { tier });
  }

  // ---- activity_processing_duration_seconds (histogram, no labels) ---------------------------
  observeActivityProcessingDurationSeconds(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error(
        `activity_processing_duration_seconds observation must be a finite, non-negative number of seconds — got ${seconds}.`,
      );
    }
    this.observeHistogram('activity_processing_duration_seconds', {}, seconds);
  }

  /** Current counter value for `name`/`labels` — `0` if never incremented, never `undefined`, so a
   * test/future exporter never has to null-check before comparing against an expected count. */
  getCounterValue(name: string, labels: Readonly<Record<string, string>> = {}): number {
    return this.counters.get(labelKey(name, labels)) ?? 0;
  }

  /** Every observation ever recorded for `name`/`labels` — `{ count: 0, sum: 0, values: [] }` if
   * never observed. */
  getHistogramSnapshot(
    name: string,
    labels: Readonly<Record<string, string>> = {},
  ): HistogramSnapshot {
    const values = this.histogramSamples.get(labelKey(name, labels)) ?? [];
    return {
      count: values.length,
      sum: values.reduce((total, value) => total + value, 0),
      values: [...values],
    };
  }

  /** Test-only reset of all in-memory metric state. Never called from a production code path —
   * this service is a process-lifetime singleton in every real deployment. */
  resetForTests(): void {
    this.counters.clear();
    this.histogramSamples.clear();
  }

  private incrementCounter(name: string, labels: Readonly<Record<string, string>>, by = 1): void {
    const key = labelKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  private observeHistogram(
    name: string,
    labels: Readonly<Record<string, string>>,
    value: number,
  ): void {
    const key = labelKey(name, labels);
    const samples = this.histogramSamples.get(key) ?? [];
    samples.push(value);
    this.histogramSamples.set(key, samples);
  }
}
