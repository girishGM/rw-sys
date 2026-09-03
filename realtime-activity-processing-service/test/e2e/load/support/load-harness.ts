/**
 * T-RAP-044. Shared harness for `test/e2e/load/**` — deliberately built on top of T-RAP-041's own
 * `full-pipeline-test-helpers.ts` (`startInstance`, `buildCampaign`, `startMockPortal`, the shared
 * Kafka-consumer-group reader lease, ...) rather than a fourth, load-test-specific composition
 * root: this task's own scope ("Out") is "no new feature work", and the exact same real
 * `GrpcMicroserviceRootModule` + real `IngestConsumerRootModule` + real
 * `ProcessingModule`/`DispatchModule`/`InvalidationModule` bundle those helpers already assemble
 * IS what a real deployment runs (per each of those modules' own `*.main.ts` header) — reusing it
 * here means this file's own load numbers describe the real pipeline, not a load-test-only stand-in
 * for it.
 *
 * **Deviation from the task file's literal "Files owned" path.** The task file lists
 * `realtime-activity-processing-service/test/load/*.ts` — that directory does not exist and is not
 * part of this agent's granted file scope (`agent-rap-qa`'s `Edit` grants, installed from
 * `realtime-activity-processing-service-plan/project.config.json`, are `test/e2e/**`,
 * `test/security/**`, `src/observability/**`, `src/modules/progress-api/**`, `docs/handover.md`,
 * `realtime-activity-processing-service-plan/reports/**`, plus one named e2e file — never
 * `test/load/**`). This lives under the granted `test/e2e/load/**` instead, matching the exact
 * precedent `promo-code-service-plan/reports/T-PC-043-load-test-results.md` already recorded for
 * the sibling project's own identical task-file/grant mismatch (`test/load/**` was never a granted
 * path there either) — not a new decision, a repeat of an already-made one.
 *
 * **What this file deliberately does NOT do.** `05-PROCESSING-PIPELINE.md` §3's advisory-lock/
 * row-lock concurrency-safety *correctness* is already proven, one mechanism at a time, by each
 * owning task's own spec (T-RAP-041's own TC-2/TC-4, `cap-enforcement.spec.ts`, etc.) — this file's
 * job is only to drive enough real, *distinct* concurrent customers/campaigns through that same
 * real machinery to measure its throughput/latency under realistic parallelism, per this task's own
 * implementation note 1 ("not an artificially single-customer hot-loop, which would only prove
 * serialization, not throughput"). It does not re-assert lock correctness itself.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import type { Producer } from 'kafkajs';
import {
  buildCampaign,
  buildCampaignBudgetCap,
  buildComponentReward,
  deriveComponentId,
  grpcActivityRequest,
  kafkaActivityMessage,
  publishActivity,
  waitUntil,
  type BuiltCampaign,
  type Instance,
} from '../../full-pipeline-test-helpers';
import { signProgressApiToken } from '@/modules/progress-api/progress-api-token';
import type { CampaignConfigProto } from '@/modules/campaign-cache/campaign-config.client';

// -------------------------------------------------------------------------------------------
// Generic rate-pacing / latency-summary helpers — same shape
// `promo-code-service/test/e2e/load/support/load-test-harness.ts` (T-PC-043) already established
// for the sibling project, reimplemented here (not imported: a different project, a different
// `node_modules` tree, no shared package) so this task's own numbers are never accidentally
// entangled with that project's own code path.
// -------------------------------------------------------------------------------------------

export interface LatencyStats {
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) {
    return 0;
  }
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx];
}

/** Real observed latency percentiles from this run's own measurements — never a synthetic or
 * assumed distribution (`AGENT-PROTOCOL.md` §3). */
export function summarizeLatencies(latenciesMs: number[]): LatencyStats {
  if (latenciesMs.length === 0) {
    return { count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  }
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    avgMs: sum / sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted[sorted.length - 1],
  };
}

/** Fires `task(i)` `totalCount` times, spaced so the *scheduling* rate (not the completion rate)
 * averages `ratePerSec` — a real sustained-load caller does not serialize on one request's
 * completion before sending the next. Every call is still collected and awaited together before
 * this resolves, so a caller always observes every attempt's outcome. */
export async function runAtRate(
  totalCount: number,
  ratePerSec: number,
  task: (index: number) => Promise<void>,
): Promise<void> {
  const intervalMs = 1000 / ratePerSec;
  const inFlight: Promise<void>[] = [];
  for (let i = 0; i < totalCount; i += 1) {
    const tickStartedAt = Date.now();
    inFlight.push(task(i));
    const elapsed = Date.now() - tickStartedAt;
    const remaining = intervalMs - elapsed;
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }
  await Promise.all(inFlight);
}

// -------------------------------------------------------------------------------------------
// Load-test campaign fixtures — several DISTINCT campaigns (distinct activityCode each), so an
// inbound activity fans out to exactly one of them, and many DISTINCT customers per campaign, so
// this file's own real concurrency touches the real per-(tenant, customer, campaign) advisory
// lock and the real per-campaign `budget_consumption` row contention many separate customers would
// legitimately produce in production — never the same single customer/campaign pair repeated,
// which would only prove serialization (this task's own implementation note 1).
// -------------------------------------------------------------------------------------------

export interface LoadCampaign {
  tenantId: number;
  campaignCode: string;
  trackerCode: string;
  componentCode: string;
  activityCode: string;
}

export function buildLoadCampaigns(
  tenantId: number,
  count: number,
): { campaigns: LoadCampaign[]; payloads: CampaignConfigProto[] } {
  const campaigns: LoadCampaign[] = [];
  const payloads: CampaignConfigProto[] = [];
  for (let i = 0; i < count; i += 1) {
    const campaignId = tenantId * 1000 + i;
    const componentId = deriveComponentId(tenantId, campaignId);
    const activityCode = `PURCHASE-LOAD-${i}`;
    const built: BuiltCampaign = buildCampaign({
      tenantId,
      campaignId,
      campaignCode: `CAMP-LOAD-${tenantId}-${i}`,
      trackerCode: `TRK-LOAD-${i}`,
      componentCode: `COMP-LOAD-${i}`,
      activityCode,
      rewards: [
        buildComponentReward(componentId, {
          policiesJson: JSON.stringify({ fixedAmount: '1.00' }),
        }),
      ],
      // Deliberately generous — this file measures throughput/latency, not cap-breach behaviour
      // (already covered by T-RAP-041 TC-4); a cap this high is never breached at this file's own
      // scale, but the per-campaign `budget_consumption` row is still written/locked on every
      // single completion, so real advisory-lock/row-lock contention still occurs.
      caps: [buildCampaignBudgetCap({ maxTotalAmount: '1000000.00' })],
    });
    campaigns.push({
      tenantId,
      campaignCode: built.payload.campaignCode,
      trackerCode: built.payload.trackers[0].trackerCode,
      componentCode: built.payload.trackers[0].components[0].componentCode,
      activityCode,
    });
    payloads.push(built.payload);
  }
  return { campaigns, payloads };
}

// -------------------------------------------------------------------------------------------
// Mixed-transport ingestion step
// -------------------------------------------------------------------------------------------

export interface SubmittedEvent {
  customerId: string;
  eventId: string;
  campaignCode: string;
  trackerCode: string;
  transport: 'GRPC' | 'KAFKA';
}

export interface IngestStepResult {
  label: string;
  targetRatePerSec: number;
  durationSec: number;
  attempted: number;
  grpcAttempted: number;
  kafkaAttempted: number;
  grpcSucceeded: number;
  grpcFailed: number;
  kafkaAcked: number;
  kafkaFailed: number;
  /** Real client-observed round-trip time of the synchronous `SubmitActivity` gRPC call — the
   * ingestion API's own latency, not full pipeline completion (matching happens synchronously in
   * that call; reward evaluation does not — see `claimToProcessedLatency` below for that number). */
  grpcLatency: LatencyStats;
  /** Real client-observed time for the Kafka producer to receive a broker ack for the publish —
   * NOT comparable to `grpcLatency` (fire-and-forget broker ack vs. a full synchronous round
   * trip), reported separately and deliberately never conflated with it. */
  kafkaAckLatency: LatencyStats;
  events: SubmittedEvent[];
}

/** Drives `ratePerSec` mixed gRPC/Kafka `SubmitActivity` traffic for `durationSec`, spread evenly
 * across `campaigns` (round-robin) with a fresh, never-repeated `(customerId, eventId)` pair every
 * time — this task's own implementation note 1's "enough concurrent distinct customers/campaigns
 * to exercise the advisory-lock/row-lock design under real contention". */
export async function runMixedIngestStep(
  instance: Instance,
  producer: Producer,
  campaigns: LoadCampaign[],
  label: string,
  ratePerSec: number,
  durationSec: number,
  grpcFraction = 0.5,
): Promise<IngestStepResult> {
  const totalCount = Math.round(ratePerSec * durationSec);
  const grpcLatencies: number[] = [];
  const kafkaLatencies: number[] = [];
  let grpcSucceeded = 0;
  let grpcFailed = 0;
  let kafkaAcked = 0;
  let kafkaFailed = 0;
  const events: SubmittedEvent[] = [];

  await runAtRate(totalCount, ratePerSec, async (i) => {
    const campaign = campaigns[i % campaigns.length];
    const customerId = `cust-${label}-${i}-${randomUUID()}`;
    const eventId = `evt-${label}-${i}-${randomUUID()}`;
    const viaGrpc = i % 10 < Math.round(grpcFraction * 10);
    const startedAt = Date.now();
    if (viaGrpc) {
      try {
        await instance.submitGrpc(
          grpcActivityRequest(customerId, eventId, { activityCode: campaign.activityCode }),
        );
        grpcLatencies.push(Date.now() - startedAt);
        grpcSucceeded += 1;
        events.push({
          customerId,
          eventId,
          campaignCode: campaign.campaignCode,
          trackerCode: campaign.trackerCode,
          transport: 'GRPC',
        });
      } catch {
        grpcFailed += 1;
      }
    } else {
      try {
        await publishActivity(
          producer,
          customerId,
          kafkaActivityMessage(campaign.tenantId, customerId, eventId, {
            activityCode: campaign.activityCode,
          }),
        );
        kafkaLatencies.push(Date.now() - startedAt);
        kafkaAcked += 1;
        events.push({
          customerId,
          eventId,
          campaignCode: campaign.campaignCode,
          trackerCode: campaign.trackerCode,
          transport: 'KAFKA',
        });
      } catch {
        kafkaFailed += 1;
      }
    }
  });

  return {
    label,
    targetRatePerSec: ratePerSec,
    durationSec,
    attempted: totalCount,
    grpcAttempted: grpcSucceeded + grpcFailed,
    kafkaAttempted: kafkaAcked + kafkaFailed,
    grpcSucceeded,
    grpcFailed,
    kafkaAcked,
    kafkaFailed,
    grpcLatency: summarizeLatencies(grpcLatencies),
    kafkaAckLatency: summarizeLatencies(kafkaLatencies),
    events,
  };
}

// -------------------------------------------------------------------------------------------
// Claim-to-processed latency — measured directly from `activity_logs`'s own real timestamps
// (`activity_reached_date` -> `activity_processed_date`, `01-DATABASE.md` §3), not a client-side
// stand-in: this is the number an operator's own DB-backed dashboard would compute, and the
// interval T-RAP-030's real claim worker + Wave 3 pipeline actually spend on each row, end to end
// (ingestion-commit through rule/budget evaluation through reward-entry commit).
// -------------------------------------------------------------------------------------------

export interface DrainResult {
  processedCount: number;
  errorCount: number;
  unresolvedCount: number;
  /** `activity_reached_date` -> `activity_processed_date`, ms, `processed` rows only. */
  claimToProcessedLatency: LatencyStats;
}

export async function waitForDrainAndMeasure(
  sequelize: Sequelize,
  tenantId: number,
  eventIds: string[],
  timeoutMs: number,
): Promise<DrainResult> {
  try {
    await waitUntil(async () => {
      const [row] = await sequelize.query<{ remaining: string }>(
        `SELECT COUNT(*) AS remaining FROM realtime_activity_processing.activity_logs
           WHERE tenant_id = :tenantId AND dedup_key IN (:eventIds)
             AND status IN ('pending','processing')`,
        { type: QueryTypes.SELECT, replacements: { tenantId, eventIds } },
      );
      return Number(row?.remaining ?? 0) === 0;
    }, timeoutMs);
  } catch {
    // Reported as `unresolvedCount` below rather than thrown — an honest finding about a real
    // capacity ceiling if this file's own steps are ever pushed past one, not a harness bug
    // (`AGENT-PROTOCOL.md` §3: "report the actual sustained rate ... not a rate chosen in
    // advance").
  }

  const rows = await sequelize.query<{
    status: string;
    reached: string;
    processed: string | null;
  }>(
    `SELECT status, activity_reached_date AS reached, activity_processed_date AS processed
       FROM realtime_activity_processing.activity_logs
      WHERE tenant_id = :tenantId AND dedup_key IN (:eventIds)`,
    { type: QueryTypes.SELECT, replacements: { tenantId, eventIds } },
  );

  const latencies: number[] = [];
  let processedCount = 0;
  let errorCount = 0;
  let unresolvedCount = 0;
  for (const row of rows) {
    if (row.status === 'processed') {
      processedCount += 1;
      if (row.processed) {
        latencies.push(new Date(row.processed).getTime() - new Date(row.reached).getTime());
      }
    } else if (row.status === 'error') {
      errorCount += 1;
    } else {
      unresolvedCount += 1;
    }
  }

  return {
    processedCount,
    errorCount,
    unresolvedCount,
    claimToProcessedLatency: summarizeLatencies(latencies),
  };
}

// -------------------------------------------------------------------------------------------
// Progress API under load — real HTTP, real auth guard, real `ProgressRepository` query, over the
// same `events` this file's own ingestion step already produced.
// -------------------------------------------------------------------------------------------

export interface ProgressApiLoadResult {
  attempted: number;
  succeeded: number;
  failed: number;
  latency: LatencyStats;
}

export async function runProgressApiLoadStep(
  progressApiApp: INestApplication,
  authSecret: Buffer,
  tenantId: number,
  events: readonly SubmittedEvent[],
  ratePerSec: number,
): Promise<ProgressApiLoadResult> {
  const latencies: number[] = [];
  let succeeded = 0;
  let failed = 0;

  await runAtRate(events.length, ratePerSec, async (i) => {
    const event = events[i];
    const token = signProgressApiToken(
      { tenantId, customerId: event.customerId, exp: Math.floor(Date.now() / 1000) + 3600 },
      authSecret,
    );
    const startedAt = Date.now();
    const response = await request(progressApiApp.getHttpServer())
      .get(
        `/progress/customers/${event.customerId}/campaigns/${event.campaignCode}/trackers/${event.trackerCode}`,
      )
      .set('Authorization', `Bearer ${token}`);
    latencies.push(Date.now() - startedAt);
    if (response.status === 200 && response.body?.isCompleted === true) {
      succeeded += 1;
    } else {
      failed += 1;
    }
  });

  return { attempted: events.length, succeeded, failed, latency: summarizeLatencies(latencies) };
}
