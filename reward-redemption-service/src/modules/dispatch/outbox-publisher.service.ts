/**
 * T-RR-034/T-RR-035. The full dual-channel dispatch to reward-tracking-service
 * (`ARCHITECTURE.md` §9): drains `PENDING` `reward_tracking_dispatch_outbox` rows, attempting the
 * `dispatch_channel_config`-resolved primary channel first (T-RR-033), falling through to the
 * resolved fallback channel, and writing a `reward_tracking_dispatch_retry` (tier 3, T-RR-035)
 * row once both attempts have failed for a row — the same proven interval-poll shape RAP's own
 * `outbox-publisher.service.ts` already established for its own outbound leg (T-RR-034's own
 * implementation note 1). This service's own outbound chain is one tier shorter than RAP's own
 * Kafka -> gRPC -> retry-table chain (no gRPC leg to reward-tracking-service exists,
 * `ARCHITECTURE.md` §9): Kafka (T-RR-034) <-> REST (T-RR-035), in whichever order
 * `dispatch_channel_config` resolves for a given row's scope, then `reward_tracking_dispatch_retry`
 * (T-RR-035) as the last resort.
 *
 * **Tier-selection algorithm** (T-RR-035 implementation note 4):
 *  1. If the resolved primary channel is disabled (`kafkaEnabled`/`restEnabled` false for that
 *     channel), it is treated as already exhausted — skip straight to step 3.
 *  2. Otherwise attempt the primary channel. On success, done (`markPublished`, tier metric).
 *     On failure:
 *     - If the primary is Kafka and the failure is a `KafkaBrokerUnreachableError` (a
 *       transport-level condition, not a per-message failure), treat it as an *immediate* signal
 *       to try REST — bypassing this row's own multi-cycle Kafka-attempts-before-fallback budget
 *       entirely (`ARCHITECTURE.md` §9's explicit "falls through to a REST call ... when Kafka is
 *       simply unavailable").
 *     - Otherwise, if this row's own `attempts` (after this failure) is still below
 *       `dispatch.kafka.attemptsBeforeFallback`, increment `attempts` and leave the row `PENDING`
 *       for a later poll cycle to retry the *same* primary channel again — never touching the
 *       fallback yet.
 *     - Once the budget is exhausted (by count, or immediately via broker-unreachable), continue
 *       to step 3 within this same cycle.
 *  3. Attempt the fallback channel (skipped if disabled, or if the failure in step 2 was
 *     broker-unreachable, in which case the fallback attempted is always REST regardless of what
 *     `dispatch_channel_config` names as fallback — `ARCHITECTURE.md` §9's own wording). On
 *     success, done. On failure (or if no fallback is available to attempt at all), write a
 *     `reward_tracking_dispatch_retry` row (TC-5) and mark this outbox row `FAILED` — tier 3 owns
 *     it from here.
 *
 * **R6/T-RR-035 implementation note 7**: this publisher never touches
 * `reward_redemption_entry.status`/`redeemed_at`/`external_reference_id` — by the time a row
 * reaches this outbox, the redemption is already durably `completed`/`dispatched_external`
 * (`05-PROCESSING-PIPELINE.md` §7). A dispatch failure at any tier only ever mutates
 * `reward_tracking_dispatch_outbox`/`reward_tracking_dispatch_retry` rows.
 *
 * **R8**: `row.payload.customerIdEncrypted` is decrypted into a plaintext `customerId` once per
 * row, held only for the duration of this cycle's attempt(s), never logged, never written back to
 * any row.
 *
 * **T-RR-071**: `doRunOnce`'s own per-row loop calls `processRowSafely`, not `processRow`
 * directly — one row throwing synchronously (a malformed `customerIdEncrypted`, or any other
 * unexpected failure) is caught and logged there, never left to abort the rest of this cycle's
 * batch. See `processRowSafely`'s own header for exactly what does (and deliberately does not)
 * happen to a row that fails this way.
 */
import {
  Injectable,
  Logger,
  Optional,
  Inject,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { EncryptionService } from '@/modules/encryption/encryption.service';
import { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';
import type { DispatchChannel } from '@/database/models/dispatch-channel-config.model';
import {
  DispatchChannelResolverService,
  type DispatchChannelResolveContext,
  type ResolvedDispatchChannel,
} from './dispatch-channel-resolver.service';
import {
  RewardTrackingOutboxRepository,
  toRewardTrackingMessage,
  type OutboxPendingRow,
} from './reward-tracking-outbox.repository';
import {
  KafkaBrokerUnreachableError,
  RewardTrackingKafkaProducerClient,
} from './reward-tracking-kafka-producer.client';
import { RewardTrackingRestClient } from './reward-tracking-rest.client';
import { RewardTrackingDispatchRetryRepository } from './reward-tracking-dispatch-retry.repository';
import { DispatchMetricsService } from './dispatch-metrics.service';
import {
  DEFAULT_OUTBOX_BATCH_SIZE,
  OUTBOX_BATCH_SIZE,
  OUTBOX_PUBLISHER_AUTOSTART,
  resolveKafkaAttemptsBeforeFallback,
  resolveOutboxPollIntervalMs,
  type DispatchServiceConfigResolver,
} from './dispatch.config';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isChannelEnabled(resolved: ResolvedDispatchChannel, channel: DispatchChannel): boolean {
  return channel === 'KAFKA' ? resolved.kafkaEnabled : resolved.restEnabled;
}

/** One attempt outcome — never throws; every failure mode (per-message, broker-unreachable) is
 * reported back to the caller as data, so `processRow`'s own tier-selection logic never has to
 * `try`/`catch` around channel-agnostic code. */
interface AttemptOutcome {
  ok: boolean;
  brokerUnreachable: boolean;
  reason: string | null;
}

const SUCCESS: AttemptOutcome = { ok: true, brokerUnreachable: false, reason: null };

@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private timer: NodeJS.Timeout | null = null;
  private cycleInFlight: Promise<void> | null = null;

  constructor(
    private readonly outboxRepository: RewardTrackingOutboxRepository,
    private readonly dispatchResolver: DispatchChannelResolverService,
    private readonly encryption: EncryptionService,
    private readonly kafkaProducer: RewardTrackingKafkaProducerClient,
    private readonly metrics: DispatchMetricsService,
    @Inject(ServiceConfigResolverService)
    private readonly configResolver: DispatchServiceConfigResolver,
    private readonly restClient: RewardTrackingRestClient,
    private readonly retryRepository: RewardTrackingDispatchRetryRepository,
    @Optional()
    @Inject(OUTBOX_BATCH_SIZE)
    private readonly batchSize: number = DEFAULT_OUTBOX_BATCH_SIZE,
    @Optional()
    @Inject(OUTBOX_PUBLISHER_AUTOSTART)
    private readonly autostart: boolean = true,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.autostart) {
      await this.start();
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** Resolves `dispatch.outbox.pollIntervalSeconds` once, then starts the interval timer —
   * idempotent (a second call while already started is a no-op), matching every other
   * interval-poll worker in this project family. */
  async start(): Promise<void> {
    if (this.timer) {
      return;
    }
    const intervalMs = await resolveOutboxPollIntervalMs(this.configResolver, this.logger);
    this.timer = setInterval(() => {
      this.runOnce().catch((error: unknown) => {
        this.logger.error(`Outbox poll cycle threw unexpectedly: ${describeError(error)}`);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll cycle, exposed so tests drive it deterministically instead of racing `setInterval` —
   * same discipline as RAP's own `runOnce()`. */
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
    const rows = await this.outboxRepository.findPendingBatch(this.batchSize);
    if (rows.length === 0) {
      return;
    }
    const attemptsBeforeFallback = await resolveKafkaAttemptsBeforeFallback(
      this.configResolver,
      this.logger,
    );
    for (const row of rows) {
      await this.processRowSafely(row, attemptsBeforeFallback);
    }
  }

  /**
   * T-RR-071: `processRow` throwing synchronously — e.g. `EncryptionService.decrypt` rejecting a
   * malformed/non-AES-GCM `customerIdEncrypted` (a genuinely corrupt row), or any other unexpected
   * failure before either channel is even attempted (`this.dispatchResolver.resolve` itself
   * erroring) — must never abort this cycle's remaining rows. Before this fix, `doRunOnce`'s own
   * `for` loop had no per-row guard, so one bad row anywhere in `findPendingBatch`'s result poisoned
   * the *entire* batch: every row after it (in `created_at ASC` order) silently never got its own
   * attempt this cycle, and `runOnce()`/`doRunOnce()` itself rejected outward to the caller.
   *
   * Deliberately does **not** call `markFailed`/`incrementAttempts`/`escalateToRetryTable` here —
   * this catch cannot distinguish permanent data corruption (which no retry could ever fix) from a
   * transient collaborator failure (e.g. a momentary `dispatch_channel_config` resolution error),
   * so it makes no guess either way. The row is simply left exactly as `findPendingBatch` found it
   * — still `PENDING`, `attempts` untouched — to be tried again from scratch on the next poll cycle,
   * indistinguishable from any other still-`PENDING` row. (A permanently-corrupt row will keep
   * failing this same way on every future cycle, occupying one `findPendingBatch` slot each time —
   * an accepted, bounded cost given this task's own evidence that fixing the *root* leak of such
   * rows, and/or cleaning up any already-stray ones, is deliberately out of this task's scope: doing
   * either from here would only mask the underlying poisoning bug, not fix this abort-the-whole-
   * batch defect.)
   */
  private async processRowSafely(
    row: OutboxPendingRow,
    attemptsBeforeFallback: number,
  ): Promise<void> {
    try {
      await this.processRow(row, attemptsBeforeFallback);
    } catch (error) {
      this.logger.error(
        `reward_tracking_dispatch_outbox row "${row.id}" (reward_entry "${row.rewardEntryId}") ` +
          `threw before any dispatch attempt completed this cycle — left PENDING, retried on a ` +
          `later poll: ${describeError(error)}`,
      );
    }
  }

  private async processRow(row: OutboxPendingRow, attemptsBeforeFallback: number): Promise<void> {
    const context: DispatchChannelResolveContext = {
      rewardCode: row.rewardCode,
      trackerCode: row.trackerCode,
      campaignCode: row.campaignCode,
      tenantId: row.tenantId,
    };
    const resolved = await this.dispatchResolver.resolve(context);
    const customerId = this.encryption.decrypt(row.payload.customerIdEncrypted);
    const message = toRewardTrackingMessage(row.payload, customerId);

    if (!isChannelEnabled(resolved, resolved.primaryChannel)) {
      // Implementation note 4: the primary channel itself is switched off — nothing to gain by
      // waiting across cycles, go straight to the fallback attempt now.
      await this.attemptFallbackOrEscalate(
        row,
        resolved,
        resolved.fallbackChannel,
        message,
        customerId,
        null,
      );
      return;
    }

    const primaryOutcome = await this.attemptChannel(
      resolved.primaryChannel,
      row,
      message,
      customerId,
    );
    if (primaryOutcome.ok) {
      await this.markDelivered(row, resolved.primaryChannel);
      return;
    }

    const budgetExhausted = row.attempts + 1 >= attemptsBeforeFallback;
    if (!primaryOutcome.brokerUnreachable && !budgetExhausted) {
      // Still within this row's own retry budget for the primary channel — stay PENDING, retried
      // again (still on the primary channel) on a later poll cycle. The fallback is never touched
      // this cycle.
      await this.outboxRepository.incrementAttempts(row.id);
      this.logger.warn(
        `${resolved.primaryChannel} dispatch failed for reward_tracking_dispatch_outbox row ` +
          `"${row.id}" (reward_entry "${row.rewardEntryId}", attempt ${row.attempts + 1}/` +
          `${attemptsBeforeFallback}): ${primaryOutcome.reason}`,
      );
      return;
    }

    // Implementation note 4: either the primary's own attempt budget is exhausted, or Kafka
    // reported the broker itself is unreachable (an immediate trigger regardless of budget) —
    // either way, attempt the fallback now, synchronously, within this same cycle.
    const fallbackChannel = primaryOutcome.brokerUnreachable ? 'REST' : resolved.fallbackChannel;
    await this.attemptFallbackOrEscalate(
      row,
      resolved,
      fallbackChannel,
      message,
      customerId,
      primaryOutcome.reason,
    );
  }

  /** Step 3 of the algorithm (this file's own header): a single, synchronous attempt at the
   * fallback channel — success delivers the row, failure (or an already-disabled/same-as-primary
   * fallback) escalates straight to `reward_tracking_dispatch_retry` (tier 3). Never retried
   * across multiple poll cycles at this stage — that is exactly what tier 3's own backoff worker
   * is for. */
  private async attemptFallbackOrEscalate(
    row: OutboxPendingRow,
    resolved: ResolvedDispatchChannel,
    fallbackChannel: DispatchChannel,
    message: Record<string, unknown>,
    customerId: string,
    primaryFailureReason: string | null = null,
  ): Promise<void> {
    if (!isChannelEnabled(resolved, fallbackChannel)) {
      await this.escalateToRetryTable(
        row,
        [primaryFailureReason, `${fallbackChannel} channel disabled or unavailable`]
          .filter((reason): reason is string => reason !== null)
          .join('; '),
      );
      return;
    }

    const fallbackOutcome = await this.attemptChannel(fallbackChannel, row, message, customerId);
    if (fallbackOutcome.ok) {
      await this.markDelivered(row, fallbackChannel);
      return;
    }

    await this.escalateToRetryTable(
      row,
      [primaryFailureReason, fallbackOutcome.reason]
        .filter((r): r is string => r !== null)
        .join('; '),
    );
  }

  private async attemptChannel(
    channel: DispatchChannel,
    row: OutboxPendingRow,
    message: Record<string, unknown>,
    customerId: string,
  ): Promise<AttemptOutcome> {
    try {
      if (channel === 'KAFKA') {
        await this.kafkaProducer.publish(row.topic, customerId, message);
      } else {
        await this.restClient.dispatch(message);
      }
      return SUCCESS;
    } catch (error) {
      return {
        ok: false,
        brokerUnreachable: error instanceof KafkaBrokerUnreachableError,
        reason: describeError(error),
      };
    }
  }

  private async markDelivered(row: OutboxPendingRow, channel: DispatchChannel): Promise<void> {
    await this.outboxRepository.markPublished(row.id);
    // T-RR-034/T-RR-035: tier success — never incremented on a failure path (implementation
    // note 6). `{tier: 'retry_table'}` is reserved for a dispatch that succeeded from
    // `reward_tracking_dispatch_retry` specifically (`RewardTrackingDispatchRetryWorker`'s own
    // call site), never here.
    this.metrics.incrementDispatchTier(channel === 'KAFKA' ? 'kafka' : 'rest');
  }

  /** TC-5: both the primary-channel attempt(s) and the immediate fallback attempt have failed (or
   * no fallback was even available to try) — writes a `reward_tracking_dispatch_retry` row and
   * marks this outbox row `FAILED`, permanently ending its own `findPendingBatch` eligibility.
   * Tier 3 (`RewardTrackingDispatchRetryWorker`) owns this reward entry's dispatch from here. */
  private async escalateToRetryTable(row: OutboxPendingRow, combinedReason: string): Promise<void> {
    await this.retryRepository.create({
      rewardEntryId: row.rewardEntryId,
      payload: row.payload,
      lastError: combinedReason || 'both dispatch tiers exhausted',
    });
    await this.outboxRepository.markFailed(row.id);
    // R8: `combinedReason` is checked by this task's own test suite never to contain
    // `customerId` — it is built only from `Error#message` strings produced by
    // `RewardTrackingKafkaProducerClient`/`RewardTrackingRestClient`, neither of which ever
    // includes the message body in its own thrown error.
    this.logger.error(
      `Both dispatch tiers exhausted for reward_tracking_dispatch_outbox row "${row.id}" ` +
        `(reward_entry "${row.rewardEntryId}") — wrote a reward_tracking_dispatch_retry row: ` +
        `${combinedReason}`,
    );
  }
}
