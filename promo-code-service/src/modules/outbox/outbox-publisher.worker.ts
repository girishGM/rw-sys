/**
 * T-PC-022. The background worker that drains `promo_code.promo_code_outbox` onto
 * `promo-code.generate.result.v1` (`01-DATABASE.md` §4, `02-KAFKA-CONTRACTS.md` §5) — so a
 * Kafka-transport generation result is never silently lost if the broker is briefly unreachable
 * at the exact moment of generation.
 *
 * Poller choice (Scope: "implementer's choice, documented in the completion report"):
 * **interval-based**, via `setInterval` on a configurable `OUTBOX_POLL_INTERVAL_MS`
 * (`outbox-publisher.config.ts`) — not `LISTEN`/`NOTIFY`. `LISTEN`/`NOTIFY` would need a
 * dedicated, always-open Postgres connection outside the pooled `Sequelize` instance this module
 * reuses (`PromoCodeConfigModule`'s `PROMO_CODE_SEQUELIZE`, same no-second-connection convention
 * `promo-code-generation.module.ts` already established) and adds a reconnect/backfill story of
 * its own for the gap while disconnected; a bounded interval poll needs neither, degrades
 * gracefully to "publishes up to one interval late," and is trivially tunable (implementation
 * note 6) without new infrastructure.
 *
 * Control flow per poll cycle (`runOnce`):
 *   1. Fetch up to `OUTBOX_BATCH_SIZE` `PENDING` rows, oldest `created_at` first (TC-4), via the
 *      partial-index-scoped query (TC-6, `OutboxRepository.findPendingBatch`).
 *   2. Skip any row still inside its own in-memory backoff window (see below).
 *   3. Process the remaining rows **sequentially, in fetched order** — not `Promise.all` — so
 *      "oldest processed first" (TC-4) is an actual publish-order guarantee, not just a
 *      same-tick race that happens to usually land that way.
 *   4. Per row: build a fresh envelope, publish, then mark `PUBLISHED` — never the reverse
 *      (implementation note 2). On failure, increment `attempts`; once `attempts` reaches
 *      `OUTBOX_MAX_ATTEMPTS`, mark `FAILED` (implementation note 3 — a broker/infrastructure
 *      failure signal, not a business-logic one) and log it distinctly (feeds T-PC-042);
 *      otherwise leave the row `PENDING` and set an in-memory exponential-backoff window before
 *      it's eligible again.
 *
 * **Why the backoff window is in-memory, not persisted**: `promo_code_outbox`
 * (`01_DATABASE.md` §4, migration `005_create_promo_code_outbox.ts`) has no
 * `next_attempt_at`/similar column, and that migration is owned by T-PC-002/`agent-promo-foundation`
 * — outside this task's scope (Scope: "Out... any change to `promo_code`/`promo_code_config`
 * tables"; the outbox table itself is likewise not this task's to alter). A restart simply
 * forgets the in-memory window and may retry a row slightly sooner than ideal backoff would have
 * — never a correctness issue, since `attempts`/`status` (the two fields the retry ceiling and
 * TC-3/TC-10 actually depend on) are still the persisted, authoritative source of truth.
 *
 * **T-PC-045**: `runOnce()`/`findPendingBatch()` fetch *globally* by default, on purpose (see
 * `OutboxRepository`'s own doc comment) — correct for this worker's real production job, but a
 * defect once more than one `OutboxPublisherWorker` instance polls the same real Postgres table
 * concurrently, which only happens under `test/e2e/**`. `runOnce(scope)` now accepts an optional
 * `OutboxBatchScope` a caller can use to constrain a cycle to specific known rows; see `runOnce`'s
 * own doc comment for what changes and what doesn't.
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  OutboxRepository,
  type OutboxBatchScope,
  type OutboxPendingRow,
} from './outbox.repository';
import { KafkaProducerService } from './kafka-producer.service';
import {
  OUTBOX_BACKOFF_BASE_MS,
  OUTBOX_BACKOFF_MAX_MS,
  OUTBOX_BATCH_SIZE,
  OUTBOX_EVENT_SOURCE,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_POLL_INTERVAL_MS,
  OUTBOX_PUBLISHER_AUTOSTART,
} from './outbox-publisher.config';

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private timer: NodeJS.Timeout | null = null;
  /** Row id → epoch-ms it becomes eligible for another attempt again (implementation note 3). */
  private readonly backoffUntil = new Map<string, number>();
  /** Guards against a slow cycle overlapping the next `setInterval` tick. */
  private cycleInFlight: Promise<void> | null = null;

  constructor(
    private readonly repository: OutboxRepository,
    private readonly kafkaProducer: KafkaProducerService,
    @Inject(OUTBOX_POLL_INTERVAL_MS) private readonly pollIntervalMs: number,
    @Inject(OUTBOX_BATCH_SIZE) private readonly batchSize: number,
    @Inject(OUTBOX_MAX_ATTEMPTS) private readonly maxAttempts: number,
    @Inject(OUTBOX_BACKOFF_BASE_MS) private readonly backoffBaseMs: number,
    @Inject(OUTBOX_BACKOFF_MAX_MS) private readonly backoffMaxMs: number,
    @Inject(OUTBOX_PUBLISHER_AUTOSTART) private readonly autostart: boolean = true,
  ) {}

  /** Rollback's own "config flag to disable it" (`OUTBOX_PUBLISHER_AUTOSTART`, see that file). */
  onModuleInit(): void {
    if (this.autostart) {
      this.start();
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.runOnce().catch((error: unknown) => {
        this.logger.error(`Outbox poll cycle threw unexpectedly: ${(error as Error).message}`);
      });
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One poll cycle, exposed directly so tests can drive it deterministically instead of racing
   * `setInterval` (same "assert the observable property" discipline as the rest of this project —
   * `runOnce` is exactly what `start()`'s interval calls, nothing bypassed).
   *
   * T-PC-045: `scope`, when supplied, is forwarded verbatim to
   * `OutboxRepository.findPendingBatch` — see that method's own doc comment. This exists for a
   * caller (in practice, an e2e test manually pumping this worker against a real, globally-shared
   * table) that wants to drain *only* rows it already knows about, without also picking up and
   * publishing a concurrently-running, unrelated test's own row before that test can observe it.
   * `start()`'s own interval-driven production path never passes one — nothing here changes
   * default/production behavior.
   *
   * A `cycleInFlight` already in progress is still returned as-is even if this call passes a
   * different `scope` than whatever triggered that in-flight cycle — this guard exists to stop a
   * slow cycle overlapping the next tick, not to multiplex differently-scoped requests. Callers
   * that need a specific scope's own result should `await` between calls rather than relying on
   * two concurrent, differently-scoped `runOnce()` calls to both apply.
   */
  async runOnce(scope?: OutboxBatchScope): Promise<void> {
    if (this.cycleInFlight) {
      return this.cycleInFlight;
    }
    this.cycleInFlight = this.doRunOnce(scope).finally(() => {
      this.cycleInFlight = null;
    });
    return this.cycleInFlight;
  }

  private async doRunOnce(scope?: OutboxBatchScope): Promise<void> {
    const rows = scope
      ? await this.repository.findPendingBatch(this.batchSize, scope)
      : await this.repository.findPendingBatch(this.batchSize);
    if (rows.length === 0) {
      // TC-11: no-op, no Kafka connection churn — `KafkaProducerService.publish` is never called.
      return;
    }
    const now = Date.now();
    const eligible = rows.filter((row) => (this.backoffUntil.get(row.id) ?? 0) <= now);
    // TC-4: process strictly in the fetched (oldest-`created_at`-first) order, sequentially.
    for (const row of eligible) {
      await this.processRow(row);
    }
  }

  private async processRow(row: OutboxPendingRow): Promise<void> {
    const context = await this.repository.findPromoCodeCorrelation(row.promoCodeId);
    if (!context) {
      // Defensive: `promo_code_id` is a `NOT NULL` FK, so this should be unreachable in practice.
      // Logged and skipped rather than thrown, so one anomalous row can never take down the
      // whole poll cycle for every other row in the batch.
      this.logger.error(
        `Outbox row "${row.id}" references promo_code_id "${row.promoCodeId}" which no longer resolves — skipping`,
      );
      return;
    }

    const envelope = this.buildEnvelope(row, context);
    try {
      // Implementation note 2: publish, then mark PUBLISHED — never the reverse.
      await this.kafkaProducer.publish(row.topic, context.correlationId, envelope);
      await this.repository.markPublished(row.id);
      this.backoffUntil.delete(row.id);
    } catch (error) {
      const attemptsAfter = row.attempts + 1;
      if (attemptsAfter >= this.maxAttempts) {
        await this.repository.markFailed(row.id);
        this.backoffUntil.delete(row.id);
        // Distinct, greppable signal (implementation note 3) — this is a broker/infrastructure
        // failure a caller is waiting on, not a business-logic FAILED result; feeds T-PC-042.
        this.logger.error(
          `OUTBOX_PUBLISH_EXHAUSTED: outbox row "${row.id}" (promo_code_id "${row.promoCodeId}") ` +
            `failed to publish after ${attemptsAfter} attempts: ${(error as Error).message}`,
        );
      } else {
        await this.repository.incrementAttempts(row.id);
        const backoffMs = Math.min(
          this.backoffBaseMs * 2 ** (attemptsAfter - 1),
          this.backoffMaxMs,
        );
        this.backoffUntil.set(row.id, Date.now() + backoffMs);
        this.logger.warn(
          `Outbox publish failed for row "${row.id}" (attempt ${attemptsAfter}/${this.maxAttempts}), ` +
            `retrying in ${backoffMs}ms: ${(error as Error).message}`,
        );
      }
    }
  }

  /**
   * Implementation note 5: built fresh on every publish attempt — a retry gets a new `eventId`
   * but the same `correlationId` (`02-KAFKA-CONTRACTS.md` §2). `data` is `row.payload` verbatim
   * (T-PC-021's own `buildResultPayload`/whatever a `FAILED`-shaped row carries, TC-9) — this
   * worker has no opinion on `SUCCESS` vs. `FAILED` shape, it only wraps whatever payload is
   * already there in a correct envelope.
   */
  private buildEnvelope(
    row: OutboxPendingRow,
    context: { correlationId: string; tenantId: string },
  ): Record<string, unknown> {
    return {
      eventId: randomUUID(),
      eventType: row.topic.replace(/\.v\d+$/, ''),
      eventVersion: '1.0',
      occurredAt: new Date().toISOString(),
      correlationId: context.correlationId,
      tenantId: context.tenantId,
      source: OUTBOX_EVENT_SOURCE,
      data: row.payload,
    };
  }
}
