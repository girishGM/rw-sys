/**
 * T-RAP-034, config-driven transport selection added by T-INT-006. Tiers 1 and 2 of
 * `05-PROCESSING-PIPELINE.md` §7 in one poller: drains `PENDING` `reward_entry_outbox` rows onto
 * this leg's currently-resolved *primary* channel (tier 1, same proven interval-poll pattern
 * `promo-code-service`'s own `OutboxPublisherWorker`, T-PC-022, already established for this
 * project's sibling — see that file's own header for the "interval-based, not LISTEN/NOTIFY"
 * reasoning, reused verbatim here), then falls through to the resolved *fallback* channel (tier 2)
 * once a row's own `attempts` reaches the `service_config`-resolved threshold (`dispatch.config.ts`).
 *
 * **T-INT-006**: the tier order used to be hardcoded Kafka-then-gRPC. It is now resolved per row,
 * from `RewardDispatchChannelResolverService`
 * (`reward_dispatch_channel_config`, `REWARD -> TRACKER -> CAMPAIGN -> GLOBAL` precedence,
 * `reward-service-integration-plan/ARCHITECTURE.md` §4/`TRANSPORT-CONFIG.md`), into one of three
 * channels (`KAFKA`/`REST`/`GRPC`) for each of the primary/fallback tiers independently — REST is a
 * wholly new option this task adds (`RewardRestFallbackClient`), alongside the two that already
 * existed. **The threshold-count decision itself is unchanged** (this task's own implementation
 * note 2): `attempts < threshold` still means "use this row's tier-1 choice", `attempts >= threshold`
 * still means "use its tier-2 choice" — only *which channel* each tier now dispatches over is
 * config-driven instead of hardcoded.
 *
 * One `runOnce()` cycle picks the tier **per row, from its own current `attempts` count** — rather
 * than tracking "which tier is this row currently on" as a separate piece of state. This is simpler
 * and exactly equivalent: a row's `attempts` count only ever moves forward (this poller is the only
 * writer), so the same threshold comparison always produces the same tier choice a stateful flag
 * would have.
 *
 * **R4**: `payload.customerIdEncrypted` is decrypted into a plaintext `customerId` **only inside
 * `processRow`**, held only for the duration of one publish/call attempt, never logged, never
 * written back to any row — the exact "decrypted at the point of publish only" boundary
 * `02-KAFKA-CONTRACTS.md` §3 and `proto/reward_ingest.proto`'s own header both specify.
 *
 * **T-RAP-059 update:** `reward_dispatch_tier_total{tier}` is incremented at this file's own
 * success call site (`attemptChannel`, `{tier: channel.toLowerCase()}`) — never on a failure path,
 * and never here for `{tier: 'retry_table'}` (that increment belongs to
 * `reward-dispatch-retry.worker.ts`'s own successful dispatch path, the only place tier 3 actually
 * succeeds — untouched by T-INT-006, this task's own Scope "Out"). Every row-specific `Logger.*`
 * call is `StructuredLogger`, reading `correlationId`/`tenantId`/`campaignCode` off `row.payload` —
 * the exact fields `buildOutboxPayload` (`reward-entry-outbox.repository.ts`) already copies from
 * `reward_entry` onto every outbox row, so no separate lookup is needed here. The plain Nest
 * `Logger` stays for `start()`'s own generic whole-cycle failure catch (no single row to attach) and
 * for `resolveRewardDispatchMaxRetryAttempts`'s shared `dispatch.config.ts` helper, which is typed
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
// T-INT-006: `RewardRestFallbackClient`/`RewardDispatchChannelResolverService` are imported as real
// values (not `import type`), even though the constructor below only *types* its parameters as
// their narrow port interfaces — `@Inject(RewardRestFallbackClient)`/
// `@Inject(RewardDispatchChannelResolverService)` need the real class reference as a DI token, per
// this file's own constructor doc comment.
import {
  RewardRestFallbackClient,
  type RewardRestFallbackClientPort,
} from './reward-rest-fallback.client';
import {
  RewardDispatchChannelResolverService,
  type RewardDispatchChannel,
  type RewardDispatchChannelResolveContext,
} from './reward-dispatch-channel-resolver.service';

/** The one method `processRow` actually needs off `RewardDispatchChannelResolverService` — narrow
 * enough that tests substitute a lightweight fake, same structural-port discipline every other
 * collaborator in this file already uses (`RewardDispatchMaxRetryResolver`). */
export interface RewardDispatchChannelResolverPort {
  resolve(context: RewardDispatchChannelResolveContext): Promise<{
    primaryChannel: RewardDispatchChannel;
    fallbackChannel: RewardDispatchChannel;
  }>;
}

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
    // T-INT-006: new REST option + config-driven resolver, inserted here (right after the two
    // pre-existing transport clients, before the collaborators T-RAP-034 already had) so every
    // existing positional-constructor caller this task must also update
    // (`dispatch.module.ts`/`outbox-publisher.spec.ts`/`dispatch-chain.e2e-spec.ts`) only needs to
    // insert two new arguments in one place, not thread them through the middle of an
    // otherwise-unrelated argument run.
    //
    // Both narrow *port* interfaces (`RewardRestFallbackClientPort`/`RewardDispatchChannelResolverPort`)
    // erase to no `design:paramtypes` metadata at runtime (TypeScript interfaces don't exist post
    // -compile) — real Nest DI (`dispatch.module.spec.ts`'s own `Test.createTestingModule` run,
    // unlike every other test in this file's own suite, which constructs `OutboxPublisherService`
    // directly with `new`) would otherwise try to resolve an implicit `Object` token and fail with
    // "Nest can't resolve dependencies ... argument at index [5]/[6]". `@Inject()` names the real,
    // concrete provider token (`dispatch.module.ts`'s own factory/class provider) explicitly, the
    // same fix `configResolver` immediately below already applies for the identical reason.
    @Inject(RewardRestFallbackClient)
    private readonly restFallback: RewardRestFallbackClientPort,
    @Inject(RewardDispatchChannelResolverService)
    private readonly channelResolver: RewardDispatchChannelResolverPort,
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

  /** T-INT-006: resolves this row's own primary/fallback channel pair from
   * `RewardDispatchChannelResolverService` (`REWARD -> TRACKER -> CAMPAIGN -> GLOBAL`, using every
   * scope field this row's own `payload` already carries) before picking which tier to attempt —
   * same threshold-count decision T-RAP-034 originally established, only the channel each tier
   * resolves to is new. */
  private async processRow(row: OutboxPendingRow): Promise<void> {
    const threshold = resolveRewardDispatchMaxRetryAttempts(this.configResolver, this.logger);
    const customerId = this.encryption.decrypt(row.payload.customerIdEncrypted);
    const { primaryChannel, fallbackChannel } = await this.channelResolver.resolve({
      rewardCode: row.payload.rewardCode,
      trackerCode: row.payload.trackerCode,
      campaignCode: row.payload.campaignCode,
      tenantId: row.payload.tenantId,
    });

    if (row.attempts < threshold) {
      await this.attemptChannel(primaryChannel, row, customerId, 'primary');
      return;
    }
    await this.attemptChannel(fallbackChannel, row, customerId, 'fallback');
  }

  /** Dispatches one row over exactly one already-resolved channel, pure transport dispatch (no
   * retry/backoff logic of its own — that lives entirely in `processRow`'s threshold check above,
   * unchanged from T-RAP-034). Throws iff the underlying transport call throws; never swallows a
   * failure itself, so `attemptChannel` below is the only place that decides what a failure means. */
  private async dispatchViaChannel(
    channel: RewardDispatchChannel,
    row: OutboxPendingRow,
    customerId: string,
  ): Promise<void> {
    switch (channel) {
      case 'KAFKA': {
        const { customerIdEncrypted: _omit, ...rest } = row.payload;
        const message = { ...rest, customerId };
        await this.kafkaProducer.publish(row.topic, customerId, message);
        return;
      }
      case 'GRPC': {
        await this.grpcFallback.submitRewardEntry(
          toRewardEntryGrpcPayload(row.payload, customerId),
        );
        return;
      }
      case 'REST': {
        await this.restFallback.submitRewardEntry(
          toRewardEntryGrpcPayload(row.payload, customerId),
        );
        return;
      }
    }
  }

  /**
   * Attempts one row over one resolved channel for one tier (`'primary'` = tier 1, `'fallback'` =
   * tier 2), generalizing T-RAP-034's own `attemptKafka`/`attemptGrpcFallback` over whichever
   * channel the resolver picked:
   *  - success: mark the outbox row `PUBLISHED` + `reward_entry` dispatched, exactly as before,
   *    regardless of which channel actually delivered it.
   *  - primary-tier failure: increment `attempts`, stays `PENDING` (same as the old
   *    `attemptKafka` failure path) — the next poll cycle re-resolves and re-attempts, same as
   *    before.
   *  - fallback-tier failure: both tiers now exhausted for this row — tier 3
   *    (`reward_dispatch_retry`) takes over, unchanged from the old `attemptGrpcFallback` failure
   *    path (T-INT-006's own Scope "Out": tier 3's own retry mechanics are untouched).
   */
  private async attemptChannel(
    channel: RewardDispatchChannel,
    row: OutboxPendingRow,
    customerId: string,
    tier: 'primary' | 'fallback',
  ): Promise<void> {
    const logContext = {
      correlationId: row.payload.correlationId,
      tenantId: row.payload.tenantId,
      campaignCode: row.payload.campaignCode,
    };

    try {
      await this.dispatchViaChannel(channel, row, customerId);
      await this.outboxRepository.markPublished(row.id);
      await this.rewardEntryRepository.markDispatched(row.rewardEntryId);
      // T-RAP-059/T-INT-006: success is recorded under the channel that actually delivered it,
      // regardless of whether this was the primary or fallback tier for this row.
      this.metrics.incrementRewardDispatchTier(channel.toLowerCase() as 'kafka' | 'rest' | 'grpc');
      if (tier === 'fallback') {
        this.structuredLogger.log(
          `Reward entry "${row.rewardEntryId}" delivered via ${channel} fallback (outbox row "${row.id}").`,
          logContext,
        );
      }
    } catch (error) {
      const reason = describeError(error);
      if (tier === 'primary') {
        await this.outboxRepository.incrementAttempts(row.id);
        await this.rewardEntryRepository.recordDispatchAttemptFailure(row.rewardEntryId, reason);
        this.structuredLogger.warn(
          `${channel} publish failed for reward_entry_outbox row "${row.id}" (attempt ${row.attempts + 1}): ${reason}`,
          logContext,
        );
        return;
      }

      // TC-5/TC-7: both tiers exhausted for this row — tier 3 (`reward_dispatch_retry`) takes over.
      await this.outboxRepository.markFailed(row.id);
      await this.rewardEntryRepository.markDispatchFailed(row.rewardEntryId, reason);
      await this.retryRepository.create({
        rewardEntryId: row.rewardEntryId,
        failureReason: reason,
      });
      this.structuredLogger.error(
        `${channel} fallback also failed for reward_entry_outbox row "${row.id}" — wrote a ` +
          `reward_dispatch_retry row for reward_entry "${row.rewardEntryId}": ${reason}`,
        logContext,
      );
    }
  }
}
