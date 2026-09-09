/**
 * T-RR-043 — load-test scenario/harness helpers shared by `load-test.ts`. Kept in its own file
 * (this task's own "Files owned" list names it explicitly) so the actual spec file reads as the
 * test itself — setup, the rate ladder, assertions — rather than being buried under scheduling
 * arithmetic.
 *
 * Reuses T-RR-041's own wire-level fixtures (`buildCanonicalFixtureEntry`/`toGrpcRewardEntry`/
 * `toRestRequestBody`) from `../fixtures/reward-entry.fixtures.ts` rather than re-inventing them a
 * third time — that file is this same agent's own (`agent-rr-qa`) file scope, so depending on it
 * staying stable carries none of the cross-agent risk `reward-entry.fixtures.ts`'s own header flags
 * for *its* reuse of T-RR-014's shape.
 */
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { QueryTypes, type Sequelize } from 'sequelize';
import type { CompletionSweepService } from '@/modules/redemption/completion-sweep.service';
import {
  buildCanonicalFixtureEntry,
  sleep,
  toGrpcRewardEntry,
  toRestRequestBody,
  type CanonicalFixtureEntry,
} from '../fixtures/reward-entry.fixtures';
import {
  callSubmitRewardEntry,
  type RewardIngestServiceTestClient,
} from '../../grpc/support/test-grpc-client';

// -------------------------------------------------------------------------------------------
// Latency stats — same shape RAP's own T-RAP-044 report already established (avg/p50/p95/p99/max)
// -------------------------------------------------------------------------------------------

export interface LatencyStats {
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export function computeLatencyStats(samples: number[]): LatencyStats {
  if (samples.length === 0) {
    return { count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number): number => {
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  };
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    count: sorted.length,
    avgMs: Math.round((sum / sorted.length) * 100) / 100,
    p50Ms: percentile(50),
    p95Ms: percentile(95),
    p99Ms: percentile(99),
    maxMs: sorted[sorted.length - 1],
  };
}

// -------------------------------------------------------------------------------------------
// Campaign fixtures
// -------------------------------------------------------------------------------------------

/** `count` distinct campaign codes, each independently configured with the `CoreBankingConnector`
 * stub outcome by the caller (`setCoreBankingStubOutcome`, `reward-entry.fixtures.ts`) — so one
 * event always fans out to exactly one campaign, no cross-campaign contention beyond what a real
 * multi-campaign workload would show. */
export function buildLoadCampaigns(tenantId: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `LOAD-${tenantId}-${i}`);
}

// -------------------------------------------------------------------------------------------
// Scheduling — an evenly-spaced, open-loop schedule of gRPC/REST sends over `durationSec`,
// interleaving a fraction of deliberate same-id duplicate resends (TC-5) via the *opposite*
// channel from the original send, scheduled as the very next slot after it (so the resend races
// genuinely-in-flight processing, not a resend long after the original already settled).
// -------------------------------------------------------------------------------------------

export type LoadEntryChannel = 'REST' | 'GRPC';

export interface ScheduledSlot {
  offsetMs: number;
  channel: LoadEntryChannel;
  fixture: CanonicalFixtureEntry;
  isDuplicate: boolean;
}

export function buildLoadSchedule(
  tenantId: number,
  campaigns: string[],
  ratePerSec: number,
  durationSec: number,
  duplicateFraction: number,
): ScheduledSlot[] {
  const totalSlots = Math.max(1, Math.round(ratePerSec * durationSec));
  const slots: ScheduledSlot[] = [];
  const recent: Array<{ fixture: CanonicalFixtureEntry; channel: LoadEntryChannel }> = [];
  // Every Nth slot (N derived from duplicateFraction) resends the immediately-preceding unique
  // fixture instead of minting a new one — e.g. duplicateFraction=0.1 -> every 10th slot.
  const duplicateEvery = duplicateFraction > 0 ? Math.max(2, Math.round(1 / duplicateFraction)) : 0;

  for (let i = 0; i < totalSlots; i += 1) {
    const offsetMs = Math.floor((i / totalSlots) * durationSec * 1000);
    const isDuplicateSlot =
      duplicateEvery > 0 && i > 0 && i % duplicateEvery === 0 && recent.length > 0;

    if (isDuplicateSlot) {
      const original = recent[recent.length - 1];
      slots.push({
        offsetMs,
        channel: original.channel === 'REST' ? 'GRPC' : 'REST',
        fixture: original.fixture,
        isDuplicate: true,
      });
    } else {
      const channel: LoadEntryChannel = i % 2 === 0 ? 'REST' : 'GRPC';
      const fixture = buildCanonicalFixtureEntry(tenantId, {
        campaignCode: campaigns[i % campaigns.length],
      });
      recent.push({ fixture, channel });
      slots.push({ offsetMs, channel, fixture, isDuplicate: false });
    }
  }
  return slots;
}

// -------------------------------------------------------------------------------------------
// Sending — real REST (supertest against the real `AppModule`) / real mTLS gRPC
// -------------------------------------------------------------------------------------------

export interface SendContext {
  grpcClient: RewardIngestServiceTestClient;
  restApp: INestApplication;
  restToken: string;
}

interface SendOutcome {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** Bounds a single send's own worst case. Real, unrelated DB contention from other concurrently
 * running processes against this same shared local Postgres instance (this task's own dev-run
 * finding — other in-flight agent sessions/tasks in this same repo can and do share this database)
 * is exactly the kind of "limiting factor" this task's own instruction says to report honestly
 * rather than silently work around — but a single stuck request must never be allowed to hang this
 * function's own `Promise.all` (and this file's own bounded jest timeout) forever. A timeout here
 * is recorded as a normal failed outcome (counted in `restFailed`/`grpcFailed`, surfaced in
 * `errorsSample`), never silently dropped. */
const SEND_TIMEOUT_MS = 10_000;

async function sendSlot(ctx: SendContext, slot: ScheduledSlot): Promise<SendOutcome> {
  const startedAt = Date.now();
  try {
    const outcome = await Promise.race([
      sendSlotUnbounded(ctx, slot),
      new Promise<SendOutcome>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`send timed out after ${SEND_TIMEOUT_MS}ms`)),
          SEND_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
    return outcome;
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function sendSlotUnbounded(ctx: SendContext, slot: ScheduledSlot): Promise<SendOutcome> {
  const startedAt = Date.now();
  try {
    if (slot.channel === 'GRPC') {
      await callSubmitRewardEntry(ctx.grpcClient, toGrpcRewardEntry(slot.fixture));
      return { ok: true, latencyMs: Date.now() - startedAt };
    }
    const response = await request(ctx.restApp.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', `Bearer ${ctx.restToken}`)
      .set('Connection', 'close')
      .send(toRestRequestBody(slot.fixture));
    if (response.status !== 200) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: `REST status ${response.status}: ${JSON.stringify(response.body)}`,
      };
    }
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface IngestStepResult {
  label: string;
  targetRatePerSec: number;
  durationSec: number;
  attempted: number;
  duplicateSlots: number;
  restSucceeded: number;
  restFailed: number;
  restLatency: LatencyStats;
  grpcSucceeded: number;
  grpcFailed: number;
  grpcLatency: LatencyStats;
  /** Every distinct fixture actually submitted this step (excludes duplicate resends, which share
   * an `id` with an already-counted entry). */
  uniqueFixtures: CanonicalFixtureEntry[];
  errors: string[];
}

/**
 * Fires every slot in `buildLoadSchedule`'s own output at its scheduled offset (an open-loop
 * workload generator — sends fire on schedule regardless of how long earlier ones took to ack,
 * which is what actually measures whether the target rate is sustainable rather than merely how
 * fast N serialized requests complete).
 */
export async function runMixedIngestStep(
  ctx: SendContext,
  tenantId: number,
  campaigns: string[],
  label: string,
  ratePerSec: number,
  durationSec: number,
  duplicateFraction: number,
): Promise<IngestStepResult> {
  const slots = buildLoadSchedule(tenantId, campaigns, ratePerSec, durationSec, duplicateFraction);
  const restLatencies: number[] = [];
  const grpcLatencies: number[] = [];
  const errors: string[] = [];
  let restSucceeded = 0;
  let restFailed = 0;
  let grpcSucceeded = 0;
  let grpcFailed = 0;

  const scheduled = slots.map(
    (slot) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          sendSlot(ctx, slot)
            .then((outcome) => {
              if (slot.channel === 'REST') {
                if (outcome.ok) {
                  restSucceeded += 1;
                  restLatencies.push(outcome.latencyMs);
                } else {
                  restFailed += 1;
                  errors.push(outcome.error ?? 'unknown REST failure');
                }
              } else if (outcome.ok) {
                grpcSucceeded += 1;
                grpcLatencies.push(outcome.latencyMs);
              } else {
                grpcFailed += 1;
                errors.push(outcome.error ?? 'unknown gRPC failure');
              }
            })
            .finally(resolve);
        }, slot.offsetMs);
      }),
  );
  await Promise.all(scheduled);

  const uniqueFixtures = slots.filter((s) => !s.isDuplicate).map((s) => s.fixture);
  return {
    label,
    targetRatePerSec: ratePerSec,
    durationSec,
    attempted: slots.length,
    duplicateSlots: slots.filter((s) => s.isDuplicate).length,
    restSucceeded,
    restFailed,
    restLatency: computeLatencyStats(restLatencies),
    grpcSucceeded,
    grpcFailed,
    grpcLatency: computeLatencyStats(grpcLatencies),
    uniqueFixtures,
    errors,
  };
}

// -------------------------------------------------------------------------------------------
// Drain-and-measure — repeatedly backdates any `dispatched_external` row for this tenant past the
// completion sweep's grace window and drives one real `CompletionSweepService.sweepOnce()` pass,
// exactly `full-pipeline.e2e-spec.ts`'s own `backdatePastCompletionSweepGrace` idiom applied in a
// batch rather than per single id (this task's own many-rows-in-flight shape) — never touches
// `completionSweep.graceSeconds` itself, so no shared `service_config` GLOBAL row is mutated by a
// concurrently-running suite.
// -------------------------------------------------------------------------------------------

export interface DrainResult {
  completedCount: number;
  failedCount: number;
  unresolvedCount: number;
  /** The real claim-worker-owned latency: `created_at` (insert time) to the moment the row first
   * reached `dispatched_external` — i.e. claim + resolve + connector-call + state-machine write,
   * captured *before* this function's own backdate step ever overwrites that row's `updated_at`.
   * This is the number that actually reflects `05-PROCESSING-PIPELINE.md` §8's own claim/connector
   * throughput claim. */
  claimToDispatchedExternalLatency: LatencyStats;
  /** `created_at` to the moment `CompletionSweepService` (driven by this same function, on its own
   * polling cadence below) finalized the row to `completed`. Reported because this task's own DoD
   * names it explicitly, but — unlike `claimToDispatchedExternalLatency` above — this number is
   * partly an artifact of this function's own drive-loop poll interval (it can only ever notice a
   * row is stale and sweep it once per iteration of this loop), not purely a production signal;
   * see this task's own completion report for that caveat spelled out against the actual numbers. */
  claimToCompletedLatency: LatencyStats;
}

export async function waitForDrainAndMeasure(
  db: Sequelize,
  completionSweep: CompletionSweepService,
  tenantId: number,
  ids: string[],
  timeoutMs: number,
): Promise<DrainResult> {
  const deadline = Date.now() + timeoutMs;
  const dispatchedLatencyMs = new Map<string, number>();
  for (;;) {
    // Capture each row's own real claim-to-dispatched-external latency the first time this loop
    // observes it in that state — strictly before the backdate step below ever touches its
    // `updated_at` (see `claimToDispatchedExternalLatency`'s own doc comment on why ordering here
    // matters).
    const freshlyDispatched = await db.query<{ id: string; latency_ms: string }>(
      `SELECT id, EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000 AS latency_ms
         FROM reward_redemption.reward_redemption_entry
        WHERE tenant_id = :tenantId AND status = 'dispatched_external' AND id IN (:ids)`,
      { type: QueryTypes.SELECT, replacements: { tenantId, ids } },
    );
    for (const row of freshlyDispatched) {
      if (!dispatchedLatencyMs.has(row.id)) {
        dispatchedLatencyMs.set(row.id, Number(row.latency_ms));
      }
    }

    await db.query(
      `UPDATE reward_redemption.reward_redemption_entry
          SET updated_at = now() - interval '1 hour'
        WHERE tenant_id = :tenantId AND status = 'dispatched_external'`,
      { type: QueryTypes.RAW, replacements: { tenantId } },
    );
    await completionSweep.sweepOnce();

    const rows = await db.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count
         FROM reward_redemption.reward_redemption_entry
        WHERE id IN (:ids)
        GROUP BY status`,
      { type: QueryTypes.SELECT, replacements: { ids } },
    );
    const byStatus = new Map(rows.map((r) => [r.status, Number(r.count)]));
    const completedCount = byStatus.get('completed') ?? 0;
    const failedCount = byStatus.get('failed') ?? 0;

    if (completedCount + failedCount >= ids.length || Date.now() >= deadline) {
      const unresolvedCount = ids.length - completedCount - failedCount;
      const latencyRows = await db.query<{ latency_ms: string }>(
        `SELECT EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000 AS latency_ms
           FROM reward_redemption.reward_redemption_entry
          WHERE id IN (:ids) AND status = 'completed'`,
        { type: QueryTypes.SELECT, replacements: { ids } },
      );
      return {
        claimToDispatchedExternalLatency: computeLatencyStats([...dispatchedLatencyMs.values()]),
        completedCount,
        failedCount,
        unresolvedCount,
        claimToCompletedLatency: computeLatencyStats(latencyRows.map((r) => Number(r.latency_ms))),
      };
    }
    await sleep(200);
  }
}

/** Bulk teardown scoped to one tenant_id — every row this file's own load ever inserted, deleted
 * in one round trip per table rather than one `DELETE` per id (this file's own scale, thousands of
 * rows, makes the per-id `cleanupEntry` helper `reward-entry.fixtures.ts` provides too slow to be
 * practical here). */
export async function cleanupLoadTestTenant(db: Sequelize, tenantId: number): Promise<void> {
  const relatedTables = [
    'notification_log',
    'reward_tracking_dispatch_retry',
    'reward_tracking_dispatch_outbox',
    'external_system_call_log',
    'reward_redemption_failed',
  ];
  for (const table of relatedTables) {
    // eslint-disable-next-line no-await-in-loop -- a fixed, short list of sequential bulk deletes
    // in test teardown; no throughput concern.
    await db.query(
      `DELETE FROM reward_redemption.${table}
        WHERE reward_entry_id IN (
          SELECT id FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenantId
        )`,
      { type: QueryTypes.RAW, replacements: { tenantId } },
    );
  }
  await db.query(
    'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenantId',
    {
      type: QueryTypes.RAW,
      replacements: { tenantId },
    },
  );
}
