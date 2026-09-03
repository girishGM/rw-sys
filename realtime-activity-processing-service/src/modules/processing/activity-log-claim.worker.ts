/**
 * T-RAP-030. The claim loop/scheduling shell — `05-PROCESSING-PIPELINE.md` §4's "a pool of workers
 * repeatedly claims one `pending` row at a time". This file owns the *outer* loop only: polling
 * cadence, per-instance concurrency (`concurrency` independent lanes, each looping
 * claim-then-immediately-reclaim-if-something-was-there / sleep-then-retry-if-not), and handing a
 * claimed row to whatever `ActivityLogRowHandler` is bound (`activity-log-row.handler.ts`). The
 * advisory lock, the rule evaluation, the progress/budget/reward writes are explicitly **not**
 * this file's concern — Scope "The advisory lock itself is NOT taken by this task ... This task's
 * own responsibility ends at 'hand the claimed, processing-status row to the handler.'"
 *
 * **Concurrency model**: `concurrency` independent "lanes", each a self-rescheduling `setTimeout`
 * chain (not a blocking `while (true)` loop) — same testable-without-real-timers shape
 * `ReconciliationPollerService`'s own `runOnce()` already established for this project, extended
 * here to N concurrent lanes instead of one. `FOR UPDATE SKIP LOCKED` (the repository's own query)
 * is what actually makes concurrent lanes — within one process *and* across many process
 * instances — safe against a double-claim; no additional application-level coordination exists or
 * is needed here (implementation note 4).
 *
 * **No busy-spin (TC-3)**: a lane that finds the queue empty schedules its next attempt
 * `pollIntervalMs()` (read fresh from `service_config` every cycle, see `processing.config.ts`)
 * later, not immediately. A lane that *did* claim something reschedules immediately (delay `0`) —
 * draining a non-empty queue as fast as the DB and handler allow, exactly the "drain the queue
 * safely" behaviour this task exists to provide.
 *
 * **A handler that throws does not crash the lane.** The row stays `processing` (this worker never
 * touches `status` again once claimed — that is the handler's/its own transaction's job,
 * `activity-log-row.handler.ts`'s own header) and `StaleProcessingSweepService` reclaims it once
 * the configured timeout elapses; the lane itself logs the error and moves on to its next poll,
 * matching `05-PROCESSING-PIPELINE.md` §3's "a crash ... simply leaves the row processing,
 * reclaimed by a stale-lock sweep ... for the next worker pass."
 *
 * **T-RAP-059 update:** `claimAndHandleOne()` now captures a claim timestamp immediately after a
 * successful claim and, once `rowHandler.handle(row)` resolves *without throwing*, observes
 * `activity_processing_duration_seconds` — the claim-to-processed latency
 * `06-CONFIGURABILITY-AND-OBSERVABILITY.md` §3 calls "the number that substantiates 'fast to
 * process realtime data'" — over the whole Wave 3 chain for that one row, not one sub-step. A
 * handler that throws is **not** observed here: the row is left `processing` for the stale sweep
 * (this file's own header, above), so this claim never actually reached a `processed`/`error`
 * terminal state and including it would understate, not measure, real claim-to-processed latency;
 * whichever later claim/attempt does reach a terminal state records its own, correct duration.
 * That same catch branch's error log is now a `StructuredLogger` entry
 * (correlationId/tenantId/campaignCode as separate fields, read off the claimed `row` itself) —
 * every *other* `Logger` call in this file (`start()`, the two generic per-lane failure catches)
 * has no specific row/activity to attach and is deliberately left on the plain Nest `Logger`,
 * since `StructuredLogger` requires a non-blank `correlationId` on every call
 * (`structured-logger.ts`'s own header) and none of those three call sites has one to give it.
 */
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { ActivityLogRow } from '@/database/models/activity-log.model';
import { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';
import { elapsedSeconds, MetricsService } from '@/observability/metrics.service';
import { StructuredLogger, StructuredLoggerFactory } from '@/observability/structured-logger';
import { ActivityLogClaimRepository } from './activity-log-claim.repository';
import { ACTIVITY_LOG_ROW_HANDLER, type ActivityLogRowHandler } from './activity-log-row.handler';
import {
  CLAIM_WORKER_AUTOSTART,
  type ConfigResolver,
  DEFAULT_CLAIM_CONCURRENCY,
  DEFAULT_CLAIM_POLL_INTERVAL_MS,
  PROCESSING_SERVICE_CONFIG_KEYS,
  resolvePositiveIntConfig,
} from './processing.config';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Logs and does nothing else — `ProcessingModule`'s own bound default until T-RAP-031 provides a
 * real one (`activity-log-row.handler.ts`'s own header). Exported so tests/verification scripts
 * can reuse it without redefining an identical stub. */
export class NoopActivityLogRowHandler implements ActivityLogRowHandler {
  private readonly logger = new Logger(NoopActivityLogRowHandler.name);

  async handle(row: ActivityLogRow): Promise<void> {
    this.logger.warn(
      `No ActivityLogRowHandler bound — claimed row ${row.id} left in 'processing', relying on ` +
        'the stale sweep to reclaim it. Bind ACTIVITY_LOG_ROW_HANDLER once T-RAP-031 lands.',
    );
  }
}

@Injectable()
export class ActivityLogClaimWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ActivityLogClaimWorker.name);
  private readonly structuredLogger: StructuredLogger;
  private readonly laneTimers = new Map<number, NodeJS.Timeout>();
  private running = false;

  constructor(
    private readonly repository: ActivityLogClaimRepository,
    // Typed as the narrower structural `ConfigResolver` (only the `resolve()` method this class
    // actually calls) so tests can inject a lightweight fake, but `@Inject` still names the real
    // class — an interface/type alias carries no runtime token for Nest's reflection-based DI to
    // resolve on its own (`design:paramtypes` erases a type-only alias to `Object`).
    @Inject(ServiceConfigResolverService) private readonly configResolver: ConfigResolver,
    private readonly metrics: MetricsService,
    loggers: StructuredLoggerFactory,
    @Optional()
    @Inject(ACTIVITY_LOG_ROW_HANDLER)
    private readonly rowHandler: ActivityLogRowHandler = new NoopActivityLogRowHandler(),
    @Optional()
    @Inject(CLAIM_WORKER_AUTOSTART)
    private readonly autostart: boolean = true,
  ) {
    this.structuredLogger = loggers.forContext(ActivityLogClaimWorker.name);
  }

  onModuleInit(): void {
    if (this.autostart) {
      this.start();
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }

  private pollIntervalMs(): number {
    return resolvePositiveIntConfig(
      this.configResolver,
      PROCESSING_SERVICE_CONFIG_KEYS.CLAIM_POLL_INTERVAL_MS,
      {},
      DEFAULT_CLAIM_POLL_INTERVAL_MS,
      this.logger,
    );
  }

  private concurrency(): number {
    return resolvePositiveIntConfig(
      this.configResolver,
      PROCESSING_SERVICE_CONFIG_KEYS.CLAIM_CONCURRENCY,
      {},
      DEFAULT_CLAIM_CONCURRENCY,
      this.logger,
    );
  }

  /** Starts `concurrency()` independent lanes. Idempotent — a second call while already running is
   * a no-op, matching `ReconciliationPollerService.start()`'s own guard. */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    const laneCount = this.concurrency();
    for (let lane = 0; lane < laneCount; lane += 1) {
      this.scheduleLane(lane, 0);
    }
    this.logger.log(`ActivityLogClaimWorker started with ${laneCount} lane(s).`);
  }

  /** Stops every lane's pending timer. A lane's own in-flight `claimAndHandleOne()` call (if any)
   * is allowed to finish — this only prevents a *new* one from being scheduled. */
  stop(): void {
    this.running = false;
    for (const timer of this.laneTimers.values()) {
      clearTimeout(timer);
    }
    this.laneTimers.clear();
  }

  private scheduleLane(lane: number, delayMs: number): void {
    if (!this.running) {
      return;
    }
    const timer = setTimeout(() => {
      this.laneTick(lane).catch((error: unknown) => {
        // laneTick itself already catches everything it can attribute to a specific cause; this
        // is the last-resort net so one unexpected throw never silently kills a lane forever.
        this.logger.error(`Lane ${lane} tick failed unexpectedly: ${describeError(error)}`);
        this.scheduleLane(lane, this.pollIntervalMs());
      });
    }, delayMs);
    // Never keeps the Node process alive on its own — same convention
    // `ReconciliationPollerService`'s own `setInterval` handle already follows.
    timer.unref?.();
    this.laneTimers.set(lane, timer);
  }

  private async laneTick(lane: number): Promise<void> {
    if (!this.running) {
      return;
    }
    let claimed: boolean;
    try {
      claimed = await this.claimAndHandleOne();
    } catch (error) {
      this.logger.error(`Lane ${lane} claim cycle failed: ${describeError(error)}`);
      claimed = false;
    }
    if (!this.running) {
      return;
    }
    // TC-3: nothing claimed -> wait the configured interval before trying again, no busy-spin.
    // Something claimed -> go again immediately, draining the queue as fast as it allows.
    this.scheduleLane(lane, claimed ? 0 : this.pollIntervalMs());
  }

  /**
   * Claims exactly one row (if any) and hands it to the bound handler — exposed (not `private`) so
   * tests drive it deterministically instead of racing lane timers, same discipline
   * `ReconciliationPollerService.runOnce()`/`OutboxPublisherWorker.runOnce()` already established
   * for this project. Returns whether a row was actually claimed (TC-3's own signal for "empty
   * queue"). A handler that throws is caught and logged here, never rethrown — see this file's own
   * header for why that is safe (the stale sweep is the actual recovery mechanism, not this
   * worker retrying the same row itself).
   */
  async claimAndHandleOne(): Promise<boolean> {
    const row = await this.repository.claimNextPendingRow();
    if (row === null) {
      return false;
    }
    const claimedAtMs = Date.now();
    try {
      await this.rowHandler.handle(row);
      // T-RAP-059: claim-to-processed latency, covering the whole Wave 3 chain for this one row —
      // only recorded on the success path (see this file's own header for why the throw branch
      // below deliberately does not observe it too).
      this.metrics.observeActivityProcessingDurationSeconds(elapsedSeconds(claimedAtMs));
    } catch (error) {
      this.structuredLogger.error(
        `ActivityLogRowHandler threw for row ${row.id} (left 'processing' for the stale sweep): ` +
          describeError(error),
        {
          correlationId: row.correlation_id,
          tenantId: row.tenant_id,
          campaignCode: row.campaign_code,
          activityLogId: row.id,
        },
      );
    }
    return true;
  }
}
