/**
 * T-RR-034/T-RR-035. The full dual-channel dispatch to reward-tracking-service
 * (`ARCHITECTURE.md` §9): drains `PENDING` `reward_tracking_dispatch_outbox` rows, attempting the
 * `dispatch_channel_config`-resolved primary channel first (T-RR-033), falling through to the
 * resolved fallback channel, and writing a `reward_tracking_dispatch_retry` (tier 3, T-RR-035)
 * row once both attempts have failed for a row — the same proven interval-poll shape RAP's own
 * `outbox-publisher.service.ts` already established for its own outbound leg (T-RR-034's own
 * implementation note 1). **T-RR-062 note**: at the time T-RR-034/T-RR-035 were built, this
 * service's own outbound chain was one tier shorter than RAP's own Kafka -> gRPC -> retry-table
 * chain ("no gRPC leg to reward-tracking-service exists," per this file's own now-superseded
 * header text) — T-RR-062 adds that third, gRPC leg (`RewardTrackingGrpcClient`), so the set of
 * channels `dispatch_channel_config` can resolve `primary_channel`/`fallback_channel` to is now
 * Kafka/REST/gRPC, in whichever order that table resolves for a given row's scope, then
 * `reward_tracking_dispatch_retry` (T-RR-035) as the last resort — matching RAP's own three-transport
 * shape, though gRPC is not expected to be the *resolved* channel on Render today
 * (`grpc_enabled` defaults `false`, `ARCHITECTURE.md` §9/implementation note 6).
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
 *
 * **T-INT-051** (`reward-service-integration-plan/tasks/T-INT-051-*.md`, filed against this exact
 * `processRowSafely` catch block): T-RR-071 stopped one bad row from aborting the whole batch, but
 * left the failure mode itself unbounded — this task bounds it. See `processRowSafely`'s own
 * header for the fix, `dispatch.config.ts`'s own `resolveOutboxMaxPreDispatchFailures` for the
 * configured threshold, and `reward-tracking-outbox.repository.ts`'s own
 * `recordPreDispatchFailure`/`findPoisoned` for the new `'POISONED'`-status mechanics.
 *
 * **T-RR-062** widens `attemptChannel()`/`isChannelEnabled()` into a real three-way switch for the
 * new `'GRPC'` `DispatchChannel` value, alongside the existing `'KAFKA'`/`'REST'` pair —
 * `RewardTrackingGrpcClient` (this task's own new file). A gRPC transport-unreachable condition
 * (`RewardTrackingGrpcUnreachableError`) is classified exactly like `KafkaBrokerUnreachableError`
 * already is (implementation note 4 above): an immediate signal to skip this row's own retry
 * budget and go straight to the fallback, never falling into the slower per-row retry-count path
 * meant for message-level failures.
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
import {
  RewardTrackingGrpcClient,
  RewardTrackingGrpcUnreachableError,
} from './reward-tracking-grpc.client';
import { RewardTrackingDispatchRetryRepository } from './reward-tracking-dispatch-retry.repository';
import { DispatchMetricsService } from './dispatch-metrics.service';
import {
  DEFAULT_OUTBOX_BATCH_SIZE,
  OUTBOX_BATCH_SIZE,
  OUTBOX_PUBLISHER_AUTOSTART,
  resolveKafkaAttemptsBeforeFallback,
  resolveOutboxMaxPreDispatchFailures,
  resolveOutboxPollIntervalMs,
  type DispatchServiceConfigResolver,
} from './dispatch.config';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isChannelEnabled(resolved: ResolvedDispatchChannel, channel: DispatchChannel): boolean {
  if (channel === 'KAFKA') {
    return resolved.kafkaEnabled;
  }
  if (channel === 'GRPC') {
    return resolved.grpcEnabled;
  }
  return resolved.restEnabled;
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
    /**
     * T-RR-062. Appended as the **last** constructor parameter, and typed optional (`?`), rather
     * than inserted alongside `kafkaProducer`/`restClient` above (its natural sibling position):
     * three files outside this task's own file scope (`test/e2e/full-pipeline.e2e-spec.ts`,
     * `test/e2e/fixtures/reward-entry.fixtures.ts`, `test/e2e/observability.e2e-spec.ts`, all
     * `agent-rr-qa`'s, R3) construct `new OutboxPublisherService(...)` directly with exactly ten
     * positional arguments ending at `autostart`. Inserting a new parameter anywhere before that
     * position would silently shift every later positional argument in those three files onto the
     * wrong parameter — a same-shape defect to the one `RewardTrackingRestClient`'s own header
     * (`T-RR-064`) already fixed for a different reason. Appending it last, `@Optional()` and
     * possibly `undefined` in exactly those three unedited files, is safe *because* none of them
     * ever exercises the gRPC path: no `dispatch_channel_config` row either seeds sets up in those
     * suites, so `attemptChannel()`'s own `'GRPC'` branch (which is the only place this field is
     * read) is never reached from them. Every real, Nest-DI-constructed instance (`dispatch.module.ts`)
     * and this task's own `outbox-publisher.service.spec.ts` still receive a real
     * `RewardTrackingGrpcClient`.
     */
    @Optional()
    private readonly grpcClient?: RewardTrackingGrpcClient,
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
    // T-INT-051: resolved once per cycle, same discipline as attemptsBeforeFallback above — only
    // ever consulted from `processRowSafely`'s own catch block (a row that throws before any
    // dispatch attempt is even made), never from the normal tier-selection path.
    const maxPreDispatchFailures = await resolveOutboxMaxPreDispatchFailures(
      this.configResolver,
      this.logger,
    );
    for (const row of rows) {
      await this.processRowSafely(row, attemptsBeforeFallback, maxPreDispatchFailures);
    }
  }

  /**
   * T-RR-071: `processRow` throwing synchronously — e.g. `EncryptionService.decrypt` rejecting a
   * malformed/non-AES-GCM `customerIdEncrypted` (a genuinely corrupt row), or any other unexpected
   * failure before either channel is even attempted (`this.dispatchResolver.resolve` itself
   * erroring) — must never abort this cycle's remaining rows. Before that fix, `doRunOnce`'s own
   * `for` loop had no per-row guard, so one bad row anywhere in `findPendingBatch`'s result poisoned
   * the *entire* batch: every row after it (in `created_at ASC` order) silently never got its own
   * attempt this cycle, and `runOnce()`/`doRunOnce()` itself rejected outward to the caller.
   *
   * **T-INT-051**: T-RR-071 fixed the abort-the-whole-batch defect above but left this failure
   * mode itself completely unbounded — `attempts` was never touched here, so a row whose failure
   * is *permanent* (not transient) stayed eligible for `findPendingBatch` forever, and because that
   * query is a strict `ORDER BY created_at ASC LIMIT $1` FIFO, the very oldest such row(s)
   * permanently occupied every poll cycle's own limited batch slots — starving every genuinely
   * dispatchable row queued behind them, no matter how far back the real backlog was (this task's
   * own filed evidence: 24,307 such rows accumulated in one local dev database). This catch now
   * calls `recordPreDispatchFailure` — the same atomic increment-and-maybe-poison step regardless
   * of whether the underlying cause turns out to be transient or permanent (this catch still
   * cannot distinguish the two, and does not try to): a transient failure that later succeeds
   * simply never accumulates enough consecutive failures to cross `maxPreDispatchFailures` (TC-2);
   * a permanent one eventually does, and is moved to the terminal `'POISONED'` status, excluded
   * from all future `findPendingBatch` batches (TC-1) — bounding the blast radius of *any*
   * permanently-broken row without needing to know, or guess, its root cause.
   */
  private async processRowSafely(
    row: OutboxPendingRow,
    attemptsBeforeFallback: number,
    maxPreDispatchFailures: number,
  ): Promise<void> {
    try {
      await this.processRow(row, attemptsBeforeFallback);
    } catch (error) {
      const reason = describeError(error);
      const { attempts, poisoned } = await this.outboxRepository.recordPreDispatchFailure(
        row.id,
        reason,
        maxPreDispatchFailures,
      );
      if (poisoned) {
        this.metrics.incrementPoisonedOutboxRow();
        this.logger.error(
          `reward_tracking_dispatch_outbox row "${row.id}" (reward_entry "${row.rewardEntryId}") ` +
            `threw before any dispatch attempt completed on ${attempts} consecutive cycles — ` +
            `exceeds dispatch.outbox.maxPreDispatchFailures (${maxPreDispatchFailures}), moved to ` +
            `POISONED and excluded from all future poll cycles: ${reason}`,
        );
        return;
      }
      this.logger.error(
        `reward_tracking_dispatch_outbox row "${row.id}" (reward_entry "${row.rewardEntryId}") ` +
          `threw before any dispatch attempt completed this cycle (pre-dispatch failure ` +
          `${attempts}/${maxPreDispatchFailures}) — left PENDING, retried on a later poll: ${reason}`,
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

    // Implementation note 4: either the primary's own attempt budget is exhausted, or the primary
    // transport itself reported unreachable (an immediate trigger regardless of budget) — either
    // way, attempt the fallback now, synchronously, within this same cycle. The "force REST"
    // override is Kafka-specific (`ARCHITECTURE.md` §9's own "falls through to a REST call ...
    // when Kafka is simply unavailable") — a gRPC-unreachable primary (T-RR-062) has no such
    // documented override and simply uses whatever `dispatch_channel_config` actually names as the
    // fallback channel, per the general step-3 rule above.
    const fallbackChannel =
      primaryOutcome.brokerUnreachable && resolved.primaryChannel === 'KAFKA'
        ? 'REST'
        : resolved.fallbackChannel;
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
      } else if (channel === 'GRPC') {
        // T-RR-062. `this.grpcClient` is only ever `undefined` for the three out-of-scope,
        // unedited e2e call sites this file's own constructor header documents — none of which
        // ever resolves `'GRPC'` as a channel, so this branch is unreachable from them in
        // practice. A real, DI-constructed graph (`dispatch.module.ts`) always supplies a real
        // instance. Guarded explicitly rather than a non-null assertion (R2) so a genuine
        // misconfiguration fails loudly with a clear message instead of a raw `TypeError`.
        if (!this.grpcClient) {
          throw new Error(
            'OutboxPublisherService: dispatch_channel_config resolved GRPC as a channel but no ' +
              'RewardTrackingGrpcClient was provided to this instance.',
          );
        }
        await this.grpcClient.dispatch(message);
      } else {
        await this.restClient.dispatch(message);
      }
      return SUCCESS;
    } catch (error) {
      return {
        ok: false,
        brokerUnreachable:
          error instanceof KafkaBrokerUnreachableError ||
          error instanceof RewardTrackingGrpcUnreachableError,
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
    // T-RR-062: a real three-way mapping, not a `KAFKA`-vs-everything-else ternary — a `GRPC`
    // delivery must never be miscounted as `rest`.
    const tier = channel === 'KAFKA' ? 'kafka' : channel === 'GRPC' ? 'grpc' : 'rest';
    this.metrics.incrementDispatchTier(tier);
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
    // `RewardTrackingKafkaProducerClient`/`RewardTrackingRestClient`/`RewardTrackingGrpcClient`
    // (T-RR-062), none of which ever includes the message body in its own thrown error.
    this.logger.error(
      `Both dispatch tiers exhausted for reward_tracking_dispatch_outbox row "${row.id}" ` +
        `(reward_entry "${row.rewardEntryId}") — wrote a reward_tracking_dispatch_retry row: ` +
        `${combinedReason}`,
    );
  }
}
