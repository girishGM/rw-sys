/**
 * T-RR-012. The Kafka transport adapter for `reward.entry.created.v1` (`02-KAFKA-CONTRACTS.md`
 * §1) — a thin adapter over `RewardIngestionService.ingest()` (T-RR-010), the identical domain
 * method the gRPC `SubmitRewardEntry` handler (T-RR-011) and the REST controller (T-RR-013) also
 * call (`AGENT-PROTOCOL.md` R10). `processMessage` does exactly two things, in a fixed order:
 * schema-validate/deserialize (`reward-entry-created.schema.ts`, implementation note 3 — a message
 * missing a mandatory field or with a malformed timestamp never reaches the domain method at all),
 * then call `ingest()`. It never itself decides a duplicate-vs-fresh outcome; that already happened
 * inside T-RR-010 by the time this adapter's call returns.
 *
 * **Insert-before-offset-commit is a hard ordering requirement, not RAP's own retry-then-DLQ
 * shape** (`ARCHITECTURE.md` §6, `02-KAFKA-CONTRACTS.md` §1's own three-step description,
 * implementation note 1). This is the one deliberate divergence from RAP's own
 * `activity-ingest.consumer.ts` (T-RAP-023) precedent, which retries *every* `ingest()` failure
 * (schema or transient) through the same bounded-retry-then-DLQ path: here, only a **schema**
 * validation failure goes through bounded retry then DLQ (implementation note 3 — retrying a
 * deterministic validation failure never changes its outcome, but a bounded retry-then-DLQ shape is
 * still applied for consistency with the sibling project's own convention and to absorb a message
 * that is merely temporarily malformed in transit). A failure from `ingest()` itself (a DB outage,
 * not a duplicate — duplicates never throw, see `RewardRedemptionEntryRepository.
 * insertOrGetExisting`'s own header) is **never** retried in-process and **never** routed to the
 * DLQ — it propagates straight out of `processMessage`, uncaught, so the real kafkajs wiring
 * (`start()` below) never reaches its own explicit offset-commit call for that message. Kafka's own
 * redelivery on the next poll is what retries it, exactly as `02-KAFKA-CONTRACTS.md` §1 requires:
 * "If the insert transaction fails for a reason other than the expected unique-violation no-op ...
 * the offset must not commit." Conflating this case with a DLQ case would violate R6 and this
 * section's own explicit instruction.
 *
 * **Manual offset-commit control** (`autoCommit: false` in `start()`'s own `consumer.run(...)`
 * call) — kafkajs's default auto-commit is disabled so this adapter decides exactly when an offset
 * advances: only once `processMessage` has resolved (never while it is still pending, never when it
 * rejects). A crash between `ingest()` durably committing and this adapter's own explicit
 * `commitOffsets` call is expected and handled, not a bug to prevent (implementation note 2): the
 * redelivered message on restart calls `ingest()` again, which resolves to the now-existing row's
 * status via T-RR-010's own unique-constraint dedup (R6) — a safe no-op, never a second row, never
 * a second dispatch.
 *
 * **DLQ is strictly for schema-invalid messages, never a duplicate `id`**
 * (`02-KAFKA-CONTRACTS.md` §1's own emphatic paragraph, R6, implementation note 3). `ingest()`
 * itself has no error case for a duplicate at all — whatever status it resolves to (fresh or
 * already-existing) is reported straight through as `'ACK'`, never inspected here for
 * "was this fresh".
 *
 * **Partition key `customerId` is a throughput/ordering convenience only** (implementation note 4,
 * `02-KAFKA-CONTRACTS.md` §1) — this adapter is correct under an arbitrary partition assignment and
 * an arbitrary number of running instances in the same group; it relies on nothing about "all
 * messages for one customer land on this one instance" for correctness, only standard kafkajs
 * consumer-group load balancing plus T-RR-010's own dedup for the real guarantee.
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
import { RewardIngestionService } from '@/modules/reward-ingestion/reward-ingestion.service';
import type { RewardEntryIngestDto } from '@/modules/reward-ingestion/reward-entry-ingest.dto';
import { validateRewardEntryCreatedMessage } from './reward-entry-created.schema';
import { RewardEntryCreatedDlqProducer } from './reward-entry-created-dlq.producer';

/** `02-KAFKA-CONTRACTS.md` §1. */
export const REWARD_ENTRY_CREATED_TOPIC = 'reward.entry.created.v1';

/**
 * Fixed and stable across restarts (`02-KAFKA-CONTRACTS.md` §1: "one shared group") — every
 * running instance of this service joins the SAME group, so Kafka's own partition-assignment
 * protocol load-balances this topic across however many instances are running.
 */
export const REWARD_ENTRY_CREATED_CONSUMER_GROUP = 'reward-redemption-service-ingest';

/**
 * "after a bounded number of consumer-side retries" (implementation note 3) — a fixed protocol
 * value, same discipline RAP's own `MAX_PROCESSING_ATTEMPTS` documents: not a different number
 * improvised at implementation time. Applies only to schema-validation failures (this class's own
 * header) — never to an `ingest()` failure, which is never retried in-process at all.
 */
export const MAX_SCHEMA_VALIDATION_ATTEMPTS = 3;

/** DI token: base delay (ms) for the exponential backoff between schema-validation attempts. */
export const RETRY_BACKOFF_BASE_MS = Symbol('REWARD_ENTRY_CREATED_RETRY_BACKOFF_BASE_MS');
export const DEFAULT_RETRY_BACKOFF_BASE_MS = 200;

/** DI token: upper bound (ms) the exponential backoff is clamped to. */
export const RETRY_BACKOFF_MAX_MS = Symbol('REWARD_ENTRY_CREATED_RETRY_BACKOFF_MAX_MS');
export const DEFAULT_RETRY_BACKOFF_MAX_MS = 5_000;

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

@Injectable()
export class RewardEntryCreatedConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RewardEntryCreatedConsumer.name);
  private consumer: Consumer | null = null;

  constructor(
    private readonly ingestionService: RewardIngestionService,
    private readonly dlqPublisher: RewardEntryCreatedDlqProducer,
    private readonly configService: ConfigService<Config, true>,
    @Inject(RETRY_BACKOFF_BASE_MS) private readonly backoffBaseMs: number,
    @Inject(RETRY_BACKOFF_MAX_MS) private readonly backoffMaxMs: number,
  ) {}

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
   * `REWARD_ENTRY_CREATED_CONSUMER_GROUP`, with manual offset-commit control (this class's own
   * header). */
  async start(): Promise<void> {
    if (this.consumer) {
      return;
    }
    const kafka = new Kafka({
      clientId: 'reward-redemption-service-ingest-consumer',
      brokers: brokersFrom(this.configService),
      logLevel: logLevel.NOTHING,
    });
    const consumer = kafka.consumer({ groupId: REWARD_ENTRY_CREATED_CONSUMER_GROUP });
    await consumer.connect();
    await consumer.subscribe({ topic: REWARD_ENTRY_CREATED_TOPIC, fromBeginning: false });
    await consumer.run({
      // Disables kafkajs's own automatic offset management (implementation note 1) — this
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
        // own header: an `ingest()` failure that is not a duplicate) skips this call entirely,
        // so kafkajs never commits this offset and redelivers the message on the next poll/after
        // a restart.
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
   * validation is retried a bounded number of times before a DLQ publish; `ingest()` itself is
   * never retried here and never swallowed — see this class's own header for why that split
   * matters for offset-commit timing.
   */
  async processMessage(raw: RawKafkaMessage): Promise<ProcessOutcome> {
    const dto = await this.validateWithBoundedRetries(raw);
    if (dto === null) {
      return 'DLQ';
    }

    // Step (b), `02-KAFKA-CONTRACTS.md` §1: durably inserts (or safely no-ops against an existing
    // row). Deliberately NOT wrapped in a try/catch here — a real failure (e.g. a DB outage) must
    // propagate straight out of this method, uncaught, so the caller never commits this message's
    // offset (this class's own header, TC-6).
    await this.ingestionService.ingest(dto);
    return 'ACK';
  }

  /**
   * Returns the validated DTO, or `null` once `MAX_SCHEMA_VALIDATION_ATTEMPTS` bounded retries are
   * exhausted and the message has already been published to the DLQ topic. Never throws.
   */
  private async validateWithBoundedRetries(
    raw: RawKafkaMessage,
  ): Promise<RewardEntryIngestDto | null> {
    let lastReason = 'unknown error';
    let bestEffortParsed: unknown;

    for (let attempt = 1; attempt <= MAX_SCHEMA_VALIDATION_ATTEMPTS; attempt += 1) {
      try {
        const parsed: unknown = JSON.parse(raw.value ?? '');
        bestEffortParsed = parsed;

        const result = validateRewardEntryCreatedMessage(parsed);
        if (!result.ok) {
          throw new Error(result.reason);
        }
        return result.dto;
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error);
        if (attempt < MAX_SCHEMA_VALIDATION_ATTEMPTS) {
          const backoffMs = Math.min(this.backoffBaseMs * 2 ** (attempt - 1), this.backoffMaxMs);
          this.logger.warn(
            `${REWARD_ENTRY_CREATED_TOPIC} schema validation failed (attempt ${attempt}/${MAX_SCHEMA_VALIDATION_ATTEMPTS}), ` +
              `retrying in ${backoffMs}ms: ${lastReason}`,
          );
          await wait(backoffMs);
        }
      }
    }

    this.logger.error(
      `${REWARD_ENTRY_CREATED_TOPIC} message routed to DLQ after ${MAX_SCHEMA_VALIDATION_ATTEMPTS} attempts: ${lastReason}`,
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
    return null;
  }
}
