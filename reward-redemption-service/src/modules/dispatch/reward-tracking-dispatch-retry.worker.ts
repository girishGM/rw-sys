/**
 * T-RR-035. Tier 3 of the dual-channel dispatch to reward-tracking-service
 * (`ARCHITECTURE.md` §9, `01-DATABASE.md` §7): the backoff worker behind
 * `reward_tracking_dispatch_retry`, reached only once `OutboxPublisherService`'s own primary and
 * immediate-fallback attempts have both already failed for a given
 * `reward_tracking_dispatch_outbox` row (`outbox-publisher.service.ts`'s own
 * `escalateToRetryTable`). Same `setInterval` + testable `runOnce()` shape as every prior
 * interval-poll worker in this project (`OutboxPublisherService` above, RAP's own
 * `reward-dispatch-retry.worker.ts`).
 *
 * **Implementation note 5**: `dispatch_channel_config` is **re-resolved at retry time**, never
 * reused from the outbox row's own original (now-stale) resolution — TC-9's own "a row sitting in
 * the retry table for a while should honor a channel-config change made since it first failed."
 * Every due cycle tries the *currently-resolved* primary channel (if enabled), then the
 * *currently-resolved* fallback channel (if enabled and it actually gets a turn) — the same
 * primary-then-fallback shape `OutboxPublisherService` uses, but collapsed into a single pass with
 * no further per-channel attempt budget: this is already the last-resort tier, so a due cycle
 * either resolves the row or counts as one failed attempt against
 * `dispatch.retry.maxAttempts` (a *different* retry budget from
 * `external_reward_system_config.max_retry_attempts`, `05-PROCESSING-PIPELINE.md` §5's own "two
 * distinct retry budgets... must not be conflated").
 *
 * **R6/R3**: this worker never touches `reward_redemption_entry.status`/`redeemed_at`/
 * `external_reference_id` — only `reward_tracking_dispatch_retry` rows (`01-DATABASE.md` §7),
 * exactly as `outbox-publisher.service.ts`'s own header documents for its sibling tiers. Decrypts
 * `customerId` only for the duration of one due cycle's attempt(s), never persisting it (R8).
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
import type { DispatchChannel } from '@/database/models/dispatch-channel-config.model';
import {
  DispatchChannelResolverService,
  type DispatchChannelResolveContext,
} from './dispatch-channel-resolver.service';
import {
  RewardTrackingDispatchRetryRepository,
  type DueRetryRow,
} from './reward-tracking-dispatch-retry.repository';
import { toRewardTrackingMessage } from './reward-tracking-outbox.repository';
import { RewardTrackingKafkaProducerClient } from './reward-tracking-kafka-producer.client';
import { RewardTrackingRestClient } from './reward-tracking-rest.client';
import { DispatchMetricsService } from './dispatch-metrics.service';
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
  resolveDispatchRetryMaxAttempts,
  type DispatchServiceConfigResolver,
} from './dispatch.config';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function tryChannel(
  channel: DispatchChannel,
  kafkaProducer: RewardTrackingKafkaProducerClient,
  restClient: RewardTrackingRestClient,
  topic: string,
  customerId: string,
  message: Record<string, unknown>,
): Promise<string | null> {
  try {
    if (channel === 'KAFKA') {
      await kafkaProducer.publish(topic, customerId, message);
    } else {
      await restClient.dispatch(message);
    }
    return null;
  } catch (error) {
    return describeError(error);
  }
}

@Injectable()
export class RewardTrackingDispatchRetryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RewardTrackingDispatchRetryWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private cycleInFlight: Promise<void> | null = null;

  constructor(
    private readonly retryRepository: RewardTrackingDispatchRetryRepository,
    private readonly dispatchResolver: DispatchChannelResolverService,
    private readonly encryption: EncryptionService,
    private readonly kafkaProducer: RewardTrackingKafkaProducerClient,
    private readonly restClient: RewardTrackingRestClient,
    private readonly metrics: DispatchMetricsService,
    @Inject(ServiceConfigResolverService)
    private readonly configResolver: DispatchServiceConfigResolver,
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
  ) {}

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
    if (rows.length === 0) {
      return;
    }
    const maxAttempts = await resolveDispatchRetryMaxAttempts(this.configResolver, this.logger);
    for (const row of rows) {
      await this.processRow(row, maxAttempts);
    }
  }

  private async processRow(row: DueRetryRow, maxAttempts: number): Promise<void> {
    // TC-9: re-resolved every due cycle, never reused from the outbox row's own original
    // (now-stale) resolution.
    const context: DispatchChannelResolveContext = {
      rewardCode: row.rewardCode,
      trackerCode: row.trackerCode,
      campaignCode: row.campaignCode,
      tenantId: row.tenantId,
    };
    const resolved = await this.dispatchResolver.resolve(context);
    const customerId = this.encryption.decrypt(row.payload.customerIdEncrypted);
    const message = toRewardTrackingMessage(row.payload, customerId);
    const topic = 'reward.redemption.completed.v1';

    const attemptOrder: DispatchChannel[] = [];
    if (resolved.kafkaEnabled && resolved.primaryChannel === 'KAFKA') {
      attemptOrder.push('KAFKA');
    }
    if (resolved.restEnabled && resolved.primaryChannel === 'REST') {
      attemptOrder.push('REST');
    }
    if (
      resolved.kafkaEnabled &&
      resolved.fallbackChannel === 'KAFKA' &&
      !attemptOrder.includes('KAFKA')
    ) {
      attemptOrder.push('KAFKA');
    }
    if (
      resolved.restEnabled &&
      resolved.fallbackChannel === 'REST' &&
      !attemptOrder.includes('REST')
    ) {
      attemptOrder.push('REST');
    }

    let lastError: string | null = null;
    for (const channel of attemptOrder) {
      const error = await tryChannel(
        channel,
        this.kafkaProducer,
        this.restClient,
        topic,
        customerId,
        message,
      );
      if (error === null) {
        await this.resolve(row.id, channel);
        return;
      }
      lastError = error;
    }

    await this.recordFailureAndMaybeExhaust(
      row,
      maxAttempts,
      lastError ??
        'no enabled dispatch channel resolved for this reward_tracking_dispatch_retry row',
    );
  }

  /** TC-7: a due attempt succeeded on either channel — row removed (this repository's own
   * `markDelivered`, `reward-tracking-dispatch-retry.repository.ts`'s own header on why deletion,
   * not a third status value). */
  private async resolve(retryRowId: string, channel: DispatchChannel): Promise<void> {
    await this.retryRepository.markDelivered(retryRowId);
    // T-RR-035 implementation note 6: `{tier: 'retry_table'}` — this tier's own one successful-
    // dispatch call site, never incremented by `OutboxPublisherService` itself.
    this.metrics.incrementDispatchTier('retry_table');
    this.logger.log(`reward_tracking_dispatch_retry row "${retryRowId}" resolved via ${channel}.`);
  }

  /** TC-8: both attempts failed again this cycle — either schedule the next backoff attempt, or,
   * once `dispatch.retry.maxAttempts` is reached, flip to `exhausted` (terminal, still queryable,
   * never retried further automatically). */
  private async recordFailureAndMaybeExhaust(
    row: DueRetryRow,
    maxAttempts: number,
    failureReason: string,
  ): Promise<void> {
    const attemptsAfter = row.attempts + 1;
    if (attemptsAfter >= maxAttempts) {
      await this.retryRepository.markExhausted(row.id, failureReason);
      this.logger.error(
        `REWARD_TRACKING_DISPATCH_RETRY_EXHAUSTED: reward_tracking_dispatch_retry row "${row.id}" ` +
          `(reward_entry "${row.rewardEntryId}") exhausted ${attemptsAfter} attempt(s): ${failureReason}`,
      );
      return;
    }
    const backoffMs = Math.min(this.backoffBaseMs * 2 ** (attemptsAfter - 1), this.backoffMaxMs);
    await this.retryRepository.recordAttemptFailure(
      row.id,
      failureReason,
      new Date(Date.now() + backoffMs),
    );
    this.logger.warn(
      `reward_tracking_dispatch_retry row "${row.id}" attempt ${attemptsAfter}/${maxAttempts} ` +
        `failed, retrying in ${backoffMs}ms: ${failureReason}`,
    );
  }
}
