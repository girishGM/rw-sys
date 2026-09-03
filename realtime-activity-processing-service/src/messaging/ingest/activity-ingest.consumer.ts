/**
 * T-RAP-023. The Kafka transport adapter for `activity.ingest.v1` (`02-KAFKA-CONTRACTS.md` §1) —
 * a thin adapter over `ActivityIngestionService.ingest` (T-RAP-021), the identical domain method
 * the gRPC `SubmitActivity` handler (T-RAP-022) calls (`AGENT-PROTOCOL.md` R5). `processMessage`
 * does exactly three things: schema-validate/deserialize (`activity-ingest-schema.validator.ts`,
 * implementation note 3 — a message missing a mandatory field or with a malformed timestamp never
 * reaches the domain method), call `ingest()`, and decide ack-vs-DLQ. It never itself decides
 * mapping/idempotency outcomes; those already happened inside T-RAP-021 by the time this
 * adapter's call returns.
 *
 * **Shared, standard consumer group** (`ingest.config.ts`'s own header) — the deliberate opposite
 * of T-RAP-011's `WatchStreamConsumer` broadcast pattern. Standard kafkajs partition-per-consumer
 * load balancing does the "each message processed exactly once *total*" work; this consumer's own
 * job is correct group configuration plus reliable ack/DLQ decisions, not orchestrating that
 * balancing itself.
 *
 * **Offset-commit timing** (implementation note 2, `02-KAFKA-CONTRACTS.md` §1's "offset commit
 * timing" note): `processMessage` never throws — every outcome (`'ACK'` or `'DLQ'`) is a return
 * value — so kafkajs's own default auto-commit (which commits once `eachMessage`'s callback
 * resolves without throwing) fires only *after* `ActivityIngestionService.ingest`'s fan-out
 * transaction has already committed (that `await` is what `processMessage` blocks on), and never
 * waits for Wave 3 processing to finish (`ingest()` returns as soon as its own transaction
 * commits, exactly like the gRPC path — `activity_ingest.proto`'s own header). A crash between the
 * DB commit and the offset commit simply redelivers the message; T-RAP-021's dedup-before-insert
 * logic (`ON CONFLICT DO NOTHING`) turns that redelivery into a safe no-op (TC-4/TC-7) — the same
 * precedent `promo-code-service`'s own `GenerateRequestedConsumer` (T-PC-030) already set for this
 * project's sibling, reused here for the identical reason.
 *
 * **DLQ is strictly for schema-invalid messages** (`02-KAFKA-CONTRACTS.md` §2): a message that
 * validates but matches no active tracker component is a completely normal `ingest()` outcome
 * (`status: 'accepted'`, `matchedTrackerComponents: []`, implementation note 4) — acknowledged
 * like any other successful call, never retried, never DLQ'd. Only a message that fails schema
 * validation, or whose `ingest()` call itself throws (e.g. a transient DB failure — not
 * distinguished from a schema failure by this adapter, since both are equally "this message could
 * not be processed"), is a DLQ candidate, and only after `MAX_PROCESSING_ATTEMPTS` bounded
 * retries with exponential backoff (`ingest.config.ts`) are exhausted.
 *
 * **Partition key is `customerId`** (implementation note 5, `02-KAFKA-CONTRACTS.md` §1) — entirely
 * a producer-side concern (the upstream activity source, not built in this repo); this consumer's
 * own responsibility toward that guarantee is correct consumer-group configuration plus
 * kafkajs's own in-partition sequential processing (`eachMessage`, nothing extra needed here to
 * preserve it). This is a helpful ordering property, not the correctness mechanism — that is
 * T-RAP-021's dedup logic and, in Wave 3, the advisory lock (implementation note 5's own text).
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, logLevel, type Consumer, type EachMessagePayload, type Producer } from 'kafkajs';
import type { Config } from '@/config/config.schema';
import { ActivityIngestionService } from '@/modules/activity-mapping/activity-ingestion.service';
import { validateActivityIngestMessage } from './activity-ingest-schema.validator';
import {
  ACTIVITY_INGEST_CONSUMER_GROUP,
  ACTIVITY_INGEST_DLQ_TOPIC,
  ACTIVITY_INGEST_TOPIC,
  MAX_PROCESSING_ATTEMPTS,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
} from './ingest.config';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function brokersFrom(configService: ConfigService<Config, true>): string[] {
  return configService
    .get('KAFKA_BROKERS', { infer: true })
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean);
}

/** The one shape both the real kafkajs message and this suite's synthetic ones share. */
export interface RawKafkaMessage {
  key: string | null;
  value: string | null;
}

export type ProcessOutcome = 'ACK' | 'DLQ';

/**
 * Lazy-connecting kafkajs producer for the DLQ topic only — the same lazy-connect-on-first-publish
 * discipline `promo-code-service`'s own `dlq-producer.service.ts` (T-PC-030) already established
 * for this project's sibling (a missing/unreachable broker must never surface as a mysterious
 * failure at boot). Reimplemented here rather than imported because that file lives outside this
 * task's own file scope (a different, standalone project) — no business logic lives here, only
 * "send one message to the DLQ topic and throw on failure"; `ActivityIngestConsumer` owns every
 * retry/backoff/DLQ-routing decision.
 */
@Injectable()
export class ActivityIngestDlqPublisher implements OnModuleDestroy {
  private readonly logger = new Logger(ActivityIngestDlqPublisher.name);
  private producer: Producer | null = null;
  private connecting: Promise<void> | null = null;

  constructor(private readonly configService: ConfigService<Config, true>) {}

  async onModuleDestroy(): Promise<void> {
    const producer = this.producer;
    this.producer = null;
    if (producer) {
      await producer.disconnect();
    }
  }

  private async connect(): Promise<void> {
    if (this.producer) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }
    const kafka = new Kafka({
      clientId: 'realtime-activity-processing-service-ingest-dlq',
      brokers: brokersFrom(this.configService),
      logLevel: logLevel.NOTHING,
      // Same reasoning `promo-code-service`'s own `dlq-producer.service.ts` documents: the
      // consumer's own bounded-retry policy already owns retry/backoff decisions at the message
      // level — kafkajs's internal connect/send retries would compound on top unpredictably.
      retry: { retries: 0 },
      connectionTimeout: 3_000,
    });
    const producer = kafka.producer();
    this.connecting = producer
      .connect()
      .then(() => {
        this.producer = producer;
      })
      .finally(() => {
        this.connecting = null;
      });
    await this.connecting;
  }

  /**
   * Publishes one message to `activity.ingest.dlq.v1`. `key` is the original message's own key
   * (the `customerId` partition key, `null` only when the original message carried no key at
   * all). Throws on any failure to connect or send — a DLQ-publish failure must never be silently
   * swallowed (see `ActivityIngestConsumer.processMessage`'s own header for what that causes: the
   * whole message is redelivered rather than lost).
   */
  async publish(key: string | null, message: Record<string, unknown>): Promise<void> {
    await this.connect();
    if (!this.producer) {
      throw new Error('ActivityIngestDlqPublisher: producer failed to connect');
    }
    try {
      await this.producer.send({
        topic: ACTIVITY_INGEST_DLQ_TOPIC,
        messages: [{ key: key ?? undefined, value: JSON.stringify(message) }],
      });
    } catch (error) {
      this.logger.error(`DLQ publish failed: ${(error as Error).message}`);
      throw error;
    }
  }
}

@Injectable()
export class ActivityIngestConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ActivityIngestConsumer.name);
  private consumer: Consumer | null = null;

  constructor(
    private readonly ingestionService: ActivityIngestionService,
    private readonly dlqPublisher: ActivityIngestDlqPublisher,
    private readonly configService: ConfigService<Config, true>,
    @Inject(RETRY_BACKOFF_BASE_MS) private readonly backoffBaseMs: number,
    @Inject(RETRY_BACKOFF_MAX_MS) private readonly backoffMaxMs: number,
  ) {}

  /**
   * Deliberately a no-op — same "module construction must never open a real broker connection"
   * discipline `promo-code-service`'s own `GenerateRequestedConsumer` (T-PC-030) already
   * established (a test's own `Test.createTestingModule` must be able to compile this module
   * without a broker running). Only `activity-ingest-consumer.main.ts`'s standalone bootstrap
   * ever calls `start()`.
   */
  onModuleInit(): void {
    // No autostart path — see this method's own comment above.
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** Starts the real kafkajs consumer loop, joining the shared `ACTIVITY_INGEST_CONSUMER_GROUP`. */
  async start(): Promise<void> {
    if (this.consumer) {
      return;
    }
    const kafka = new Kafka({
      clientId: 'realtime-activity-processing-service-ingest-consumer',
      brokers: brokersFrom(this.configService),
      logLevel: logLevel.NOTHING,
    });
    const consumer = kafka.consumer({ groupId: ACTIVITY_INGEST_CONSUMER_GROUP });
    await consumer.connect();
    await consumer.subscribe({ topic: ACTIVITY_INGEST_TOPIC, fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ message }: EachMessagePayload) => {
        await this.processMessage({
          key: message.key ? message.key.toString() : null,
          value: message.value ? message.value.toString() : null,
        });
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
   * suite drive directly (`AGENT-PROTOCOL.md` §3: "assert the observable property"). Bounded
   * retry wraps the entire pipeline (parse → schema-validate → `ingest()`) uniformly, same
   * precedent `promo-code-service`'s own `GenerateRequestedConsumer` sets: a schema failure
   * (TC-2/TC-3) and a transient `ingest()` failure both go through the identical
   * bounded-retry-then-DLQ path. Never throws — see this class's own header for why that matters
   * for offset-commit timing.
   */
  async processMessage(raw: RawKafkaMessage): Promise<ProcessOutcome> {
    let lastReason = 'unknown error';
    let bestEffortParsed: unknown;

    for (let attempt = 1; attempt <= MAX_PROCESSING_ATTEMPTS; attempt += 1) {
      try {
        const parsed: unknown = JSON.parse(raw.value ?? '');
        bestEffortParsed = parsed;

        // Implementation note 3: schema validation happens BEFORE `ingest()` is ever called.
        const result = validateActivityIngestMessage(parsed);
        if (!result.ok) {
          throw new Error(result.reason);
        }

        await this.ingestionService.ingest(result.activity);
        // TC-1/TC-4/TC-6: whatever `ingest()` decided (accepted, duplicate, or a zero-match
        // no-op) is a normal, successfully-processed outcome from this adapter's own point of
        // view — acknowledged, never retried, never DLQ'd.
        return 'ACK';
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error);
        if (attempt < MAX_PROCESSING_ATTEMPTS) {
          const backoffMs = Math.min(this.backoffBaseMs * 2 ** (attempt - 1), this.backoffMaxMs);
          this.logger.warn(
            `${ACTIVITY_INGEST_TOPIC} processing failed (attempt ${attempt}/${MAX_PROCESSING_ATTEMPTS}), ` +
              `retrying in ${backoffMs}ms: ${lastReason}`,
          );
          await wait(backoffMs);
        }
      }
    }

    this.logger.error(
      `${ACTIVITY_INGEST_TOPIC} message routed to DLQ after ${MAX_PROCESSING_ATTEMPTS} attempts: ${lastReason}`,
    );
    // Preserve the original parsed body untouched when there is one to preserve — for a message
    // that never parsed as JSON at all, there is no body to preserve, so the raw original string
    // is embedded verbatim instead (best-effort equivalent for an unparseable payload).
    const dlqBody =
      typeof bestEffortParsed === 'object' &&
      bestEffortParsed !== null &&
      !Array.isArray(bestEffortParsed)
        ? (bestEffortParsed as Record<string, unknown>)
        : { raw: raw.value };
    await this.dlqPublisher.publish(raw.key, {
      ...dlqBody,
      error: lastReason,
      failedAt: new Date().toISOString(),
    });
    return 'DLQ';
  }
}
