/**
 * T-RTS-012. The Kafka transport adapter for `reward.redemption.completed.v1`
 * (`reward-redemption-service-plan/02-KAFKA-CONTRACTS.md` §2, read-only reference — R0 forbids
 * writing to that sibling plan/service, never forbids reading its contract) — a thin adapter over
 * `RewardTrackingIngestionService.applyRewardTrackingEvent()` (T-RTS-010), the identical domain
 * method the gRPC controller (T-RTS-011) and the REST controller (T-RTS-013) also call
 * (`AGENT-PROTOCOL.md` R8). `processMessage` does exactly two things, in a fixed order:
 * schema-validate/deserialize (`reward-tracking-event.schema.ts`), then call
 * `applyRewardTrackingEvent()`. It never itself decides an applied-vs-duplicate outcome; that
 * already happened inside T-RTS-010 by the time this adapter's call returns.
 *
 * **At-least-once, idempotent-by-design** (this task's own implementation note 1) — a redelivered
 * message calls `applyRewardTrackingEvent()` again; T-RTS-010's own `inbound_event_log` uniqueness
 * on `reward_entry_id` makes the second call a safe no-op (TC-2). This adapter adds, and must add,
 * no dedupe logic of its own.
 *
 * **Schema-invalid -> bounded retry -> DLQ; everything else -> propagate, never DLQ, never
 * swallowed** (this task's own implementation note 2, mirroring
 * `reward-redemption-service`'s own `reward-entry-created.consumer.ts` (T-RR-012, confirmed by
 * direct read) split exactly): a message that fails `reward-tracking-event.schema.ts`'s own
 * validation is retried a bounded number of times (`MAX_SCHEMA_VALIDATION_ATTEMPTS`, with backoff
 * — a message that is merely temporarily malformed in transit gets a second chance) before being
 * published to `reward.redemption.completed.dlq.v1` and the offset committed — the consumer keeps
 * running, never crash-loops on one bad message (TC-3). A failure from
 * `applyRewardTrackingEvent()` itself (e.g. a DB outage — never a duplicate, which never throws;
 * see `RewardTrackingIngestionService`'s own header) is **never** retried in-process here and
 * **never** routed to the DLQ — it propagates straight out of `processMessage`, uncaught, so the
 * real kafkajs wiring (`start()` below) never reaches its own explicit offset-commit call for that
 * message; Kafka's own redelivery on the next poll (or after a restart) is what retries it.
 * Conflating this case with a DLQ case would risk silently discarding a real, transiently-failed
 * event.
 *
 * **Manual offset-commit control** (`autoCommit: false` in `start()`'s own `consumer.run(...)`
 * call) — this adapter alone decides when an offset advances: only once `processMessage` has
 * resolved (never while still pending, never when it rejects).
 *
 * **No business logic** (this task's own implementation note 3, R8) — same discipline T-RTS-011's
 * gRPC controller documents for itself: this class never decides whether an event is valid
 * business-wise, only whether it is well-formed enough to hand to the one shared domain method.
 *
 * **TC-4 — `customerId` never appears in any log line.** This class's own log lines reference only
 * `rewardEntryId`/`topic`/`partition`/error messages — never `key` (the Kafka partition key, which
 * carries the plaintext `customerId`, `reward-redemption-service-plan/02-KAFKA-CONTRACTS.md` §2's
 * own "Partition key: `customerId`" note) and never the parsed message body. The one log line this
 * whole pipeline emits on a successful/duplicate ingest is `RewardTrackingIngestionService`'s own
 * (T-RTS-010's header), which logs `customerIdHash`, never the raw value.
 *
 * **R6 fix (post-review): `customerId` never reaches the DLQ topic in the clear either** — not just
 * never logged. The independent review of this task's first submission caught a real gap this
 * header's TC-4 paragraph above did not cover: a schema-invalid message whose failure reason was
 * some OTHER field (e.g. `campaignCode is required`) still carries a perfectly well-formed
 * `customerId`, and `validateWithBoundedRetries` was spreading that raw, JSON-parsed body verbatim
 * into the published DLQ message — plaintext `customerId` in both the body and the Kafka key (the
 * source topic's own partition key, same plaintext value). Fixed by `sanitizeForDlq` (strips
 * `customerId` from the body, substitutes `customerIdHash`) and by hashing `raw.key` before it is
 * ever passed to `dlqPublisher.publish` — both unconditional, applied to every DLQ publish this
 * class makes, not just the "some other field failed" case that exposed the gap.
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, logLevel, type Consumer, type EachMessagePayload } from 'kafkajs';
import type { Config } from '@/config/config.schema';
import {
  RewardTrackingIngestionService,
  type ApplyRewardTrackingEventInput,
} from '@/modules/ingestion/reward-tracking-ingestion.service';
import { CustomerIdCryptoService } from '@/modules/ingestion/customer-id-crypto.service';
import { MetricsService } from '@/observability/metrics.service';
import { StructuredLoggerFactory, type StructuredLogger } from '@/observability/logging.module';
import { parseRewardTrackingEventMessage } from './reward-tracking-event.schema';
import { RewardTrackingDlqProducer } from './reward-tracking-dlq.producer';

/** `reward-redemption-service-plan/02-KAFKA-CONTRACTS.md` §2's own topic name — read-only
 * reference, never a value this service itself owns or may redefine (R0). */
export const REWARD_TRACKING_COMPLETED_TOPIC = 'reward.redemption.completed.v1';

/** This task's own suggested consumer group name ("Scope" section: "a consumer group (e.g.
 * `reward-tracking-service.redemption-completed`)") — fixed and stable across restarts, same
 * "one shared group" reasoning `reward-redemption-service`'s own
 * `REWARD_ENTRY_CREATED_CONSUMER_GROUP` documents: every running instance of this service joins
 * the SAME group, so Kafka's own partition-assignment protocol load-balances this topic across
 * however many instances are running. */
export const REWARD_TRACKING_COMPLETED_CONSUMER_GROUP =
  'reward-tracking-service.redemption-completed';

/** A fixed, stable protocol value — same discipline the sibling consumer's own
 * `MAX_SCHEMA_VALIDATION_ATTEMPTS` documents: not a different number improvised at implementation
 * time. Applies only to schema-validation failures (this class's own header) — never to an
 * `applyRewardTrackingEvent()` failure, which is never retried in-process at all. */
export const MAX_SCHEMA_VALIDATION_ATTEMPTS = 3;

/** DI token: base delay (ms) for the exponential backoff between schema-validation attempts. */
export const RETRY_BACKOFF_BASE_MS = Symbol('REWARD_TRACKING_CONSUMER_RETRY_BACKOFF_BASE_MS');
export const DEFAULT_RETRY_BACKOFF_BASE_MS = 200;

/** DI token: upper bound (ms) the exponential backoff is clamped to. */
export const RETRY_BACKOFF_MAX_MS = Symbol('REWARD_TRACKING_CONSUMER_RETRY_BACKOFF_MAX_MS');
export const DEFAULT_RETRY_BACKOFF_MAX_MS = 5_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** T-RTS-049 — best-effort `correlationId` extraction for the DLQ-routing log line: a message that
 * never parsed as JSON, or parsed but never carried a `correlationId` field (itself possibly the
 * reason validation failed), has nothing real to report — `'unknown'` keeps `StructuredLogger`
 * (which requires a non-blank `correlationId`) from throwing a second, masking error on top of the
 * one already being reported. */
function correlationIdOrUnknown(parsed: unknown): string {
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const value = (parsed as Record<string, unknown>).correlationId;
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return 'unknown';
}

function brokersFrom(configService: ConfigService<Config, true>): string[] {
  return configService
    .get('KAFKA_BROKERS', { infer: true })
    .split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
}

/** The one shape both the real kafkajs message and this suite's synthetic ones share. */
export interface RawKafkaMessage {
  key: string | null;
  value: string | null;
}

export type ProcessOutcome = 'ACK' | 'DLQ';

@Injectable()
export class RewardTrackingConsumerService implements OnModuleInit, OnModuleDestroy {
  /** Kept alongside `structuredLogger` below (T-RTS-049) — still used for the bounded-retry
   * warning line, which this task's own evidence never named as one of the two call sites to
   * convert (only the applied/duplicate line and the DLQ-routing line were). */
  private readonly logger = new Logger(RewardTrackingConsumerService.name);
  private consumer: Consumer | null = null;
  /** T-RTS-049 — structured logger for the two call sites this task's evidence names explicitly. */
  private readonly structuredLogger: StructuredLogger;

  constructor(
    private readonly ingestionService: RewardTrackingIngestionService,
    private readonly dlqPublisher: RewardTrackingDlqProducer,
    private readonly configService: ConfigService<Config, true>,
    @Inject(RETRY_BACKOFF_BASE_MS) private readonly backoffBaseMs: number,
    @Inject(RETRY_BACKOFF_MAX_MS) private readonly backoffMaxMs: number,
    /** Own instance, not a shared provider from `RewardTrackingIngestionModule` (which exports only
     * `RewardTrackingIngestionService`, R10 — that module's own provider list is T-RTS-010's owned
     * file, not this task's) — same "build a second, stateless instance rather than take on an
     * unrelated module's whole surface" precedent `customer-rewards-api.module.ts` (T-RTS-030)
     * already established for this exact class. Used **only** to hash (never encrypt/decrypt) a
     * plaintext `customerId` that must never reach the DLQ topic in the clear (R6, this fix for the
     * gap the independent review of this task caught — see `kafka.module.ts`'s own header). */
    private readonly crypto: CustomerIdCryptoService,
    private readonly metrics: MetricsService,
    loggers: StructuredLoggerFactory,
  ) {
    this.structuredLogger = loggers.forContext(RewardTrackingConsumerService.name);
  }

  /**
   * Deliberately a no-op — module construction (including a test's own
   * `Test.createTestingModule`) must never open a real broker connection. Only
   * `kafka-consumer.main.ts`'s standalone bootstrap ever calls `start()`.
   */
  onModuleInit(): void {
    // No autostart path — see this method's own comment above.
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** Starts the real kafkajs consumer loop, joining the shared
   * `REWARD_TRACKING_COMPLETED_CONSUMER_GROUP`, with manual offset-commit control (this class's
   * own header). */
  async start(): Promise<void> {
    if (this.consumer) {
      return;
    }
    const kafka = new Kafka({
      clientId: 'reward-tracking-service-ingest-consumer',
      brokers: brokersFrom(this.configService),
      logLevel: logLevel.NOTHING,
    });
    const consumer = kafka.consumer({ groupId: REWARD_TRACKING_COMPLETED_CONSUMER_GROUP });
    await consumer.connect();
    await consumer.subscribe({ topic: REWARD_TRACKING_COMPLETED_TOPIC, fromBeginning: false });
    await consumer.run({
      // Disables kafkajs's own automatic offset management (this class's own header) — this
      // adapter alone decides when an offset advances, via the explicit `commitOffsets` call
      // below.
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
        await this.processMessage({
          key: message.key ? message.key.toString() : null,
          value: message.value ? message.value.toString() : null,
        });
        // Reached only when `processMessage` resolved without throwing — an `'ACK'` (fresh
        // insert or a safe duplicate no-op) or a `'DLQ'` (the schema-invalid message was already
        // published to the DLQ topic), both safe to advance past. A thrown error (this class's
        // own header: an `applyRewardTrackingEvent()` failure that is not a duplicate) skips this
        // call entirely, so kafkajs never commits this offset and redelivers the message on the
        // next poll/after a restart.
        await consumer.commitOffsets([
          { topic, partition, offset: (Number(message.offset) + 1).toString() },
        ]);
      },
    });
    this.consumer = consumer;
  }

  async stop(): Promise<void> {
    const consumer = this.consumer;
    this.consumer = null;
    if (consumer) {
      await consumer.disconnect();
    }
  }

  /**
   * The one entry point both the real kafkajs `eachMessage` loop (above) and this task's own test
   * suite drive directly (`AGENT-PROTOCOL.md` §3: "assert the observable property"). Schema
   * validation is retried a bounded number of times before a DLQ publish; `applyRewardTrackingEvent()`
   * itself is never retried here and never swallowed — see this class's own header for why that
   * split matters for offset-commit timing.
   */
  async processMessage(raw: RawKafkaMessage): Promise<ProcessOutcome> {
    const input = await this.validateWithBoundedRetries(raw);
    if (input === null) {
      return 'DLQ';
    }

    // Deliberately NOT wrapped in a try/catch here — a real failure (e.g. a DB outage) must
    // propagate straight out of this method, uncaught, so the caller never commits this message's
    // offset (this class's own header, TC-3's own "consumer continues" counterpart for the
    // non-schema-failure case).
    const result = await this.ingestionService.applyRewardTrackingEvent(input);
    // T-RTS-049 item 3 — no separate metrics increment here: `applyRewardTrackingEvent()` (T-RTS-010)
    // already increments `reward_tracking_events_ingested_total{channel:'KAFKA', outcome:result.status}`
    // once per call, right before returning — pairing a second increment with this log line would
    // double-count the identical event. Only the structured-logging/correlationId fix applies.
    this.structuredLogger.log(`${REWARD_TRACKING_COMPLETED_TOPIC} message processed`, {
      correlationId: input.correlationId,
      rewardEntryId: result.rewardEntryId,
      status: result.status,
    });
    return 'ACK';
  }

  /**
   * Returns the validated `ApplyRewardTrackingEventInput`, or `null` once
   * `MAX_SCHEMA_VALIDATION_ATTEMPTS` bounded retries are exhausted and the message has already
   * been published to the DLQ topic. Never throws.
   */
  private async validateWithBoundedRetries(
    raw: RawKafkaMessage,
  ): Promise<ApplyRewardTrackingEventInput | null> {
    let lastReason = 'unknown error';
    let bestEffortParsed: unknown;

    for (let attempt = 1; attempt <= MAX_SCHEMA_VALIDATION_ATTEMPTS; attempt += 1) {
      try {
        const parsed: unknown = JSON.parse(raw.value ?? '');
        bestEffortParsed = parsed;

        const result = parseRewardTrackingEventMessage(parsed);
        if (!result.ok) {
          throw new Error(result.reason);
        }
        return result.input;
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error);
        if (attempt < MAX_SCHEMA_VALIDATION_ATTEMPTS) {
          const backoffMs = Math.min(this.backoffBaseMs * 2 ** (attempt - 1), this.backoffMaxMs);
          // Never interpolates the parsed body itself (may carry a plaintext `customerId`, R6) —
          // only the failure reason and the attempt/backoff bookkeeping (TC-4).
          this.logger.warn(
            `${REWARD_TRACKING_COMPLETED_TOPIC} schema validation failed (attempt ${attempt}/${MAX_SCHEMA_VALIDATION_ATTEMPTS}), ` +
              `retrying in ${backoffMs}ms: ${lastReason}`,
          );
          await wait(backoffMs);
        }
      }
    }

    // T-RTS-049 item 3 — the DLQ-routing branch is a genuine failed ingestion attempt over this
    // channel (it never reaches `applyRewardTrackingEvent()`'s own increment), so it gets its own
    // metric here, paired with the structured/correlationId log fix.
    this.metrics.incrementEventsIngested('KAFKA', 'failed');
    this.structuredLogger.error(
      `${REWARD_TRACKING_COMPLETED_TOPIC} message routed to DLQ after ${MAX_SCHEMA_VALIDATION_ATTEMPTS} attempts: ${lastReason}`,
      { correlationId: correlationIdOrUnknown(bestEffortParsed) },
    );
    // Preserve the original parsed body untouched when there is one to preserve — for a message
    // that never parsed as JSON at all, there is no body to preserve, so the raw original string
    // is embedded verbatim instead (best-effort equivalent for an unparseable payload). Matches
    // `reward-redemption-service`'s own `reward-entry-created.consumer.ts` DLQ-body convention
    // exactly (T-RR-012, confirmed by direct read) — with one deliberate departure from that
    // convention this fix adds: `sanitizeForDlq` below strips the plaintext `customerId` field
    // before this body is ever spread into the published message, regardless of which OTHER field
    // is the actual reason the message failed validation (R6 — see this method's own header for
    // why "campaignCode is required" is not license to leave `customerId` in the clear).
    const dlqBody =
      typeof bestEffortParsed === 'object' &&
      bestEffortParsed !== null &&
      !Array.isArray(bestEffortParsed)
        ? this.sanitizeForDlq(bestEffortParsed as Record<string, unknown>)
        : { raw: raw.value };
    // The Kafka key on the SOURCE topic is `customerId` in the clear (this class's own header,
    // `reward-redemption-service-plan/02-KAFKA-CONTRACTS.md` §2's "Partition key: customerId").
    // Forwarding it verbatim as the DLQ message's own key would leak the plaintext value into
    // `reward.redemption.completed.dlq.v1` even when `sanitizeForDlq` above successfully stripped
    // it from the body (R6) — hash it instead, the same one-way primitive `sanitizeForDlq` uses for
    // the body, so a DLQ consumer can still correlate messages by customer without ever seeing the
    // plaintext value. Applied unconditionally, for BOTH the schema-parses-but-invalid-field path
    // and the not-valid-JSON-at-all path (the latter's body has no `customerId` field to sanitize
    // out of the unparseable raw string, but its Kafka key still carries the same plaintext
    // partition key and must be hashed the same way).
    const dlqKey = raw.key ? this.crypto.hash(raw.key) : null;
    await this.dlqPublisher.publish(dlqKey, {
      ...dlqBody,
      error: lastReason,
      failedAt: new Date().toISOString(),
    });
    return null;
  }

  /**
   * Strips a plaintext `customerId` field (if present) out of a DLQ-bound body, substituting a
   * `customerIdHash` in its place — the identical "never write the plaintext field, substitute a
   * hash/encrypted form" discipline `reward-tracking-ingestion.service.ts`'s own `toLoggedPayload`
   * already applies to `inbound_event_log.payload` (R6), applied here to this class's own DLQ path
   * instead. Deliberately unconditional — this runs on every schema-invalid-but-parseable body,
   * regardless of which OTHER field made the message invalid, since a message can carry a
   * well-formed `customerId` while still failing validation on any other field (TC-3's own
   * "missing campaignCode" shape is exactly this case).
   */
  private sanitizeForDlq(body: Record<string, unknown>): Record<string, unknown> {
    const { customerId, ...rest } = body;
    if (typeof customerId === 'string' && customerId.length > 0) {
      return { ...rest, customerIdHash: this.crypto.hash(customerId) };
    }
    return rest;
  }
}
