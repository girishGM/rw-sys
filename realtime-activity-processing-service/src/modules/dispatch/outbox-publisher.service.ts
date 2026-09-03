/**
 * T-RAP-034. Tiers 1 and 2 of `05-PROCESSING-PIPELINE.md` §7 in one poller: drains `PENDING`
 * `reward_entry_outbox` rows onto `reward.entry.created.v1` (tier 1, same proven interval-poll
 * pattern `promo-code-service`'s own `OutboxPublisherWorker`, T-PC-022, already established for
 * this project's sibling — see that file's own header for the "interval-based, not LISTEN/NOTIFY"
 * reasoning, reused verbatim here), then falls through to a synchronous
 * `RewardIngestService.SubmitRewardEntry` call (tier 2) once a row's own `attempts` reaches the
 * `service_config`-resolved threshold (`dispatch.config.ts`).
 *
 * One `runOnce()` cycle picks the tier **per row, from its own current `attempts` count** —
 * `attempts < threshold` tries Kafka, `attempts >= threshold` tries gRPC instead — rather than
 * tracking "which tier is this row currently on" as a separate piece of state. This is simpler and
 * exactly equivalent: a row's `attempts` count only ever moves forward (this poller is the only
 * writer), so the same threshold comparison always produces the same tier choice a stateful flag
 * would have.
 *
 * **R4**: `payload.customerIdEncrypted` is decrypted into a plaintext `customerId` **only inside
 * `processRow`**, held only for the duration of one publish/call attempt, never logged, never
 * written back to any row — the exact "decrypted at the point of publish only" boundary
 * `02-KAFKA-CONTRACTS.md` §3 and `proto/reward_ingest.proto`'s own header both specify.
 *
 * **T-RAP-059 update:** `reward_dispatch_tier_total{tier}` is incremented at this file's own two
 * success call sites — `{tier: 'kafka'}` in `attemptKafka`, `{tier: 'grpc'}` in
 * `attemptGrpcFallback` — never on a failure path, and never here for `{tier: 'retry_table'}`
 * (that increment belongs to `reward-dispatch-retry.worker.ts`'s own successful dispatch path, the
 * only place tier 3 actually succeeds). Every row-specific `Logger.*` call (the three inside
 * `attemptKafka`/`attemptGrpcFallback`) is replaced with `StructuredLogger`, reading
 * `correlationId`/`tenantId`/`campaignCode` off `row.payload` — the exact fields
 * `buildOutboxPayload` (`reward-entry-outbox.repository.ts`) already copies from `reward_entry`
 * onto every outbox row, so no separate lookup is needed here. The plain Nest `Logger` stays for
 * `start()`'s own generic whole-cycle failure catch (no single row to attach) and for
 * `resolveRewardDispatchMaxRetryAttempts`'s shared `dispatch.config.ts` helper, which is typed
 * against the concrete `Logger`, same reasoning `rule-evaluation-row-handler.service.ts`'s own
 * header gives for `resolveAdvisoryLockWaitTimeoutMs`.
 */
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { EncryptionService } from '@/modules/encryption/encryption.service';
import { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';
import { MetricsService } from '@/observability/metrics.service';
import { StructuredLogger, StructuredLoggerFactory } from '@/observability/structured-logger';
import {
  RewardEntryOutboxRepository,
  type OutboxBatchScope,
  type OutboxPendingRow,
} from '@/modules/reward-entry/reward-entry-outbox.repository';
import { RewardEntryRepository } from '@/modules/reward-entry/reward-entry.repository';
import {
  DEFAULT_OUTBOX_BATCH_SIZE,
  DEFAULT_OUTBOX_POLL_INTERVAL_MS,
  OUTBOX_BATCH_SIZE,
  OUTBOX_POLL_INTERVAL_MS,
  OUTBOX_PUBLISHER_AUTOSTART,
  resolveRewardDispatchMaxRetryAttempts,
  type RewardDispatchMaxRetryResolver,
} from './dispatch.config';
import { RewardDispatchRetryRepository } from './reward-dispatch-retry.repository';
import { RewardKafkaProducerClient } from './reward-kafka-producer.client';
import { RewardGrpcFallbackClient, toRewardEntryGrpcPayload } from './reward-grpc-fallback.client';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private readonly structuredLogger: StructuredLogger;
  private timer: NodeJS.Timeout | null = null;
  private cycleInFlight: Promise<void> | null = null;

  constructor(
    private readonly outboxRepository: RewardEntryOutboxRepository,
    private readonly rewardEntryRepository: RewardEntryRepository,
    private readonly retryRepository: RewardDispatchRetryRepository,
    private readonly kafkaProducer: RewardKafkaProducerClient,
    private readonly grpcFallback: RewardGrpcFallbackClient,
    private readonly encryption: EncryptionService,
    @Inject(ServiceConfigResolverService)
    private readonly configResolver: RewardDispatchMaxRetryResolver,
    private readonly metrics: MetricsService,
    loggers: StructuredLoggerFactory,
    @Optional()
    @Inject(OUTBOX_POLL_INTERVAL_MS)
    private readonly pollIntervalMs: number = DEFAULT_OUTBOX_POLL_INTERVAL_MS,
    @Optional()
    @Inject(OUTBOX_BATCH_SIZE)
    private readonly batchSize: number = DEFAULT_OUTBOX_BATCH_SIZE,
    @Optional()
    @Inject(OUTBOX_PUBLISHER_AUTOSTART)
    private readonly autostart: boolean = true,
  ) {
    this.structuredLogger = loggers.forContext(OutboxPublisherService.name);
  }

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
        this.logger.error(`Outbox poll cycle threw unexpectedly: ${describeError(error)}`);
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

  /** One poll cycle, exposed so tests drive it deterministically instead of racing `setInterval` —
   * same discipline as every prior interval-poll worker in this project (T-RAP-011/030,
   * `promo-code-service`'s own `OutboxPublisherWorker`). `scope`, when supplied, constrains
   * `findPendingBatch` to a caller-known set of row ids (`OutboxBatchScope`'s own header) — never
   * used by the real `start()` interval path, only by tests sharing this globally-scoped table
   * with other suites. */
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
    const rows = await this.outboxRepository.findPendingBatch(this.batchSize, scope);
    for (const row of rows) {
      await this.processRow(row);
    }
  }

  private async processRow(row: OutboxPendingRow): Promise<void> {
    const threshold = resolveRewardDispatchMaxRetryAttempts(this.configResolver, this.logger);
    const customerId = this.encryption.decrypt(row.payload.customerIdEncrypted);

    if (row.attempts < threshold) {
      await this.attemptKafka(row, customerId);
      return;
    }
    await this.attemptGrpcFallback(row, customerId);
  }

  /** Tier 1. */
  private async attemptKafka(row: OutboxPendingRow, customerId: string): Promise<void> {
    const { customerIdEncrypted: _omit, ...rest } = row.payload;
    const message = { ...rest, customerId };
    try {
      await this.kafkaProducer.publish(row.topic, customerId, message);
      await this.outboxRepository.markPublished(row.id);
      await this.rewardEntryRepository.markDispatched(row.rewardEntryId);
      // T-RAP-059: tier 1 success.
      this.metrics.incrementRewardDispatchTier('kafka');
    } catch (error) {
      const reason = describeError(error);
      await this.outboxRepository.incrementAttempts(row.id);
      await this.rewardEntryRepository.recordDispatchAttemptFailure(row.rewardEntryId, reason);
      this.structuredLogger.warn(
        `Kafka publish failed for reward_entry_outbox row "${row.id}" (attempt ${row.attempts + 1}): ${reason}`,
        {
          correlationId: row.payload.correlationId,
          tenantId: row.payload.tenantId,
          campaignCode: row.payload.campaignCode,
        },
      );
    }
  }

  /** Tier 2. */
  private async attemptGrpcFallback(row: OutboxPendingRow, customerId: string): Promise<void> {
    const grpcPayload = toRewardEntryGrpcPayload(row.payload, customerId);
    try {
      await this.grpcFallback.submitRewardEntry(grpcPayload);
      // §7 point 2: mark both the outbox row and reward_entry.dispatch_status as delivered — this
      // row's own `findPendingBatch` eligibility ends here, so tier 1 never retries it again.
      await this.outboxRepository.markPublished(row.id);
      await this.rewardEntryRepository.markDispatched(row.rewardEntryId);
      // T-RAP-059: tier 2 success.
      this.metrics.incrementRewardDispatchTier('grpc');
      this.structuredLogger.log(
        `Reward entry "${row.rewardEntryId}" delivered via gRPC fallback (outbox row "${row.id}").`,
        {
          correlationId: row.payload.correlationId,
          tenantId: row.payload.tenantId,
          campaignCode: row.payload.campaignCode,
        },
      );
    } catch (error) {
      const reason = describeError(error);
      // TC-5: both tiers exhausted for this row — tier 3 (`reward_dispatch_retry`) takes over.
      await this.outboxRepository.markFailed(row.id);
      await this.rewardEntryRepository.markDispatchFailed(row.rewardEntryId, reason);
      await this.retryRepository.create({
        rewardEntryId: row.rewardEntryId,
        failureReason: reason,
      });
      this.structuredLogger.error(
        `gRPC fallback also failed for reward_entry_outbox row "${row.id}" — wrote a ` +
          `reward_dispatch_retry row for reward_entry "${row.rewardEntryId}": ${reason}`,
        {
          correlationId: row.payload.correlationId,
          tenantId: row.payload.tenantId,
          campaignCode: row.payload.campaignCode,
        },
      );
    }
  }
}
