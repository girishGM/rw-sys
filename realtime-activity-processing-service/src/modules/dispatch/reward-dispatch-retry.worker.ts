/**
 * T-RAP-034. Tier 3 of `05-PROCESSING-PIPELINE.md` §7: the backoff worker behind
 * `reward_dispatch_retry` (`01-DATABASE.md` §9), reached only once both the Kafka outbox poller
 * (tier 1) and the synchronous gRPC fallback (tier 2, both `outbox-publisher.service.ts`) have
 * already failed for a given reward. Same `setInterval` + testable `runOnce()` shape as every
 * prior interval-poll worker in this project (`stale-processing-sweep.service.ts`,
 * `outbox-publisher.service.ts` above).
 *
 * Implementation note 4: "retries Kafka then gRPC (same order) up to
 * `reward_dispatch_max_retry_attempts`, then flips to `exhausted`" — every due cycle for a row
 * tries **both** channels (Kafka first; only tries gRPC if Kafka itself failed that same cycle),
 * since by construction every row here already failed both once before this table's own row was
 * ever created. This is a stricter, faster-converging reading than re-running tier 1/2's own
 * threshold split a second time, and it means both `kafka_attempts`/`grpc_attempts` advance
 * together on any cycle where neither channel succeeds — `reward-dispatch-retry.repository.ts`'s
 * own `recordDualAttemptFailure` header.
 *
 * R3/R4 apply identically to this tier: this worker never touches whether the underlying
 * `reward_entry` row exists, only `reward_dispatch_retry.status`/`reward_entry.dispatch_status`,
 * and decrypts `customerId` only for the duration of one attempt, never persisting it.
 *
 * **T-RAP-059 update:** `reward_dispatch_tier_total{tier: 'retry_table'}` is incremented in
 * `resolve()` — this tier's own one successful-dispatch call site — and every `Logger.*` call that
 * has a resolved `reward_entry` row to attach (`resolve()`, `recordFailureAndMaybeExhaust()`) is
 * replaced with `StructuredLogger`, reading `correlationId`/`tenantId`/`campaignCode` straight off
 * that `RewardEntryRow`. `processRow`'s own defensive "reward_entry_id no longer resolves" branch
 * has no such row to read a `correlationId` from (that is exactly the failure it is reporting) and
 * is deliberately left on the plain Nest `Logger`, same reasoning
 * `activity-log-claim.worker.ts`'s own header gives for its own context-less log lines.
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
  REWARD_ENTRY_CREATED_TOPIC,
  buildOutboxPayload,
} from '@/modules/reward-entry/reward-entry-outbox.repository';
import { RewardEntryRepository } from '@/modules/reward-entry/reward-entry.repository';
import type { RewardEntryRow } from '@/database/models/reward-entry.model';
import type { RewardDispatchRetryRow } from '@/database/models/reward-dispatch-retry.model';
import {
  DEFAULT_RETRY_BACKOFF_BASE_MS,
  DEFAULT_RETRY_BACKOFF_MAX_MS,
  DEFAULT_RETRY_BATCH_SIZE,
  DEFAULT_RETRY_WORKER_POLL_INTERVAL_MS,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  RETRY_BATCH_SIZE,
  RETRY_WORKER_AUTOSTART,
  RETRY_WORKER_POLL_INTERVAL_MS,
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
export class RewardDispatchRetryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RewardDispatchRetryWorker.name);
  private readonly structuredLogger: StructuredLogger;
  private timer: NodeJS.Timeout | null = null;
  private cycleInFlight: Promise<void> | null = null;

  constructor(
    private readonly retryRepository: RewardDispatchRetryRepository,
    private readonly rewardEntryRepository: RewardEntryRepository,
    private readonly kafkaProducer: RewardKafkaProducerClient,
    private readonly grpcFallback: RewardGrpcFallbackClient,
    private readonly encryption: EncryptionService,
    @Inject(ServiceConfigResolverService)
    private readonly configResolver: RewardDispatchMaxRetryResolver,
    private readonly metrics: MetricsService,
    loggers: StructuredLoggerFactory,
    @Optional()
    @Inject(RETRY_WORKER_POLL_INTERVAL_MS)
    private readonly pollIntervalMs: number = DEFAULT_RETRY_WORKER_POLL_INTERVAL_MS,
    @Optional()
    @Inject(RETRY_BATCH_SIZE)
    private readonly batchSize: number = DEFAULT_RETRY_BATCH_SIZE,
    @Optional()
    @Inject(RETRY_BACKOFF_BASE_MS)
    private readonly backoffBaseMs: number = DEFAULT_RETRY_BACKOFF_BASE_MS,
    @Optional()
    @Inject(RETRY_BACKOFF_MAX_MS)
    private readonly backoffMaxMs: number = DEFAULT_RETRY_BACKOFF_MAX_MS,
    @Optional()
    @Inject(RETRY_WORKER_AUTOSTART)
    private readonly autostart: boolean = true,
  ) {
    this.structuredLogger = loggers.forContext(RewardDispatchRetryWorker.name);
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
        this.logger.error(`Retry-table poll cycle threw unexpectedly: ${describeError(error)}`);
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

  /** One poll cycle, exposed so tests drive it deterministically instead of racing `setInterval`. */
  async runOnce(): Promise<void> {
    if (this.cycleInFlight) {
      return this.cycleInFlight;
    }
    this.cycleInFlight = this.doRunOnce().finally(() => {
      this.cycleInFlight = null;
    });
    return this.cycleInFlight;
  }

  private async doRunOnce(): Promise<void> {
    const rows = await this.retryRepository.findDueBatch(this.batchSize);
    for (const row of rows) {
      await this.processRow(row);
    }
  }

  private async processRow(row: RewardDispatchRetryRow): Promise<void> {
    const rewardEntry = await this.rewardEntryRepository.findById(row.reward_entry_id);
    if (rewardEntry === null) {
      // Defensive: `reward_entry_id` is a `NOT NULL` FK, so this should be unreachable in
      // practice. Logged and skipped rather than thrown, so one anomalous row can never take down
      // a whole poll cycle for every other due row in the batch.
      this.logger.error(
        `reward_dispatch_retry row "${row.id}" references reward_entry_id "${row.reward_entry_id}" ` +
          'which no longer resolves — skipping.',
      );
      return;
    }

    const customerId = this.encryption.decrypt(rewardEntry.customer_id_encrypted);
    const outboxShapedPayload = buildOutboxPayload(rewardEntry);
    const { customerIdEncrypted: _omit, ...rest } = outboxShapedPayload;
    const kafkaMessage = { ...rest, customerId };

    const kafkaError = await this.tryKafka(kafkaMessage, customerId);
    if (kafkaError === null) {
      await this.resolve(row.id, rewardEntry);
      return;
    }

    const grpcPayload = toRewardEntryGrpcPayload(outboxShapedPayload, customerId);
    const grpcError = await this.tryGrpc(grpcPayload);
    if (grpcError === null) {
      await this.resolve(row.id, rewardEntry);
      return;
    }

    await this.recordFailureAndMaybeExhaust(
      row,
      rewardEntry,
      `kafka: ${kafkaError}; grpc: ${grpcError}`,
    );
  }

  private async tryKafka(message: Record<string, unknown>, key: string): Promise<string | null> {
    try {
      await this.kafkaProducer.publish(REWARD_ENTRY_CREATED_TOPIC, key, message);
      return null;
    } catch (error) {
      return describeError(error);
    }
  }

  private async tryGrpc(
    payload: ReturnType<typeof toRewardEntryGrpcPayload>,
  ): Promise<string | null> {
    try {
      await this.grpcFallback.submitRewardEntry(payload);
      return null;
    } catch (error) {
      return describeError(error);
    }
  }

  /** TC-6: a retry attempt succeeded on either channel. */
  private async resolve(retryRowId: string, rewardEntry: RewardEntryRow): Promise<void> {
    await this.retryRepository.markResolved(retryRowId);
    await this.rewardEntryRepository.markDispatched(rewardEntry.id);
    // T-RAP-059: tier 3 (retry-table) success — the only call site this tier ever actually
    // succeeds from.
    this.metrics.incrementRewardDispatchTier('retry_table');
    this.structuredLogger.log(`reward_dispatch_retry row "${retryRowId}" resolved.`, {
      correlationId: rewardEntry.correlation_id,
      tenantId: rewardEntry.tenant_id,
      campaignCode: rewardEntry.campaign_code,
    });
  }

  /** TC-7: both channels failed again this cycle — either schedule the next backoff attempt, or,
   * once the configured ceiling is reached, flip to `exhausted` (still queryable, feeds T-RAP-043's
   * observability — `01-DATABASE.md` §9). */
  private async recordFailureAndMaybeExhaust(
    row: RewardDispatchRetryRow,
    rewardEntry: RewardEntryRow,
    failureReason: string,
  ): Promise<void> {
    const maxAttempts = resolveRewardDispatchMaxRetryAttempts(this.configResolver, this.logger);
    const attemptsAfter = Math.max(row.kafka_attempts, row.grpc_attempts) + 1;
    const logFields = {
      correlationId: rewardEntry.correlation_id,
      tenantId: rewardEntry.tenant_id,
      campaignCode: rewardEntry.campaign_code,
    };
    if (attemptsAfter >= maxAttempts) {
      await this.retryRepository.markExhausted(row.id, failureReason);
      this.structuredLogger.error(
        `REWARD_DISPATCH_RETRY_EXHAUSTED: reward_dispatch_retry row "${row.id}" (reward_entry ` +
          `"${row.reward_entry_id}") exhausted ${attemptsAfter} attempt(s): ${failureReason}`,
        logFields,
      );
      return;
    }
    const backoffMs = Math.min(this.backoffBaseMs * 2 ** (attemptsAfter - 1), this.backoffMaxMs);
    await this.retryRepository.recordDualAttemptFailure(
      row.id,
      failureReason,
      new Date(Date.now() + backoffMs),
    );
    this.structuredLogger.warn(
      `reward_dispatch_retry row "${row.id}" attempt ${attemptsAfter}/${maxAttempts} failed, ` +
        `retrying in ${backoffMs}ms: ${failureReason}`,
      logFields,
    );
  }
}
