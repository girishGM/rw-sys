/**
 * T-RTS-012. Lazy-connecting `kafkajs` producer for `reward.redemption.completed.dlq.v1` —
 * schema-invalid messages only (this task's own implementation note 2: "Deserialization failure
 * -> dead-letter, never a crash-loop"). Mirrors `reward-redemption-service`'s own
 * `reward-entry-created-dlq.producer.ts` (T-RR-012, confirmed by direct read) lazy-connect-on-
 * first-publish discipline: a missing/unreachable broker must never surface as a mysterious
 * failure at boot, only at the point a DLQ publish is actually attempted.
 *
 * No business logic lives here (R8) — only "send one message to the DLQ topic and throw on
 * failure". `RewardTrackingConsumerService` owns every retry/backoff/DLQ-routing decision.
 *
 * Not added to this task's own literal "Files owned" list in the task file, but squarely inside
 * this agent's delegated `src/kafka/**` scope grant and necessary to produce a real DLQ for this
 * task's own TC-3/verification step 2 — same "extra file added when the implementation genuinely
 * needs it, inside this agent's own scope grant" precedent `T-RTS-011`'s own `grpc-server.main.ts`
 * already established (see that file's own header) — flagged explicitly in this task's completion
 * report.
 */
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import type { Config } from '@/config/config.schema';

/** `reward.redemption.completed.v1`'s own DLQ, named following
 * `reward-redemption-service`'s own `<topic>.dlq.v1` convention (`reward.entry.created.v1` ->
 * `reward.entry.created.dlq.v1`, T-RR-012). */
export const REWARD_TRACKING_COMPLETED_DLQ_TOPIC = 'reward.redemption.completed.dlq.v1';

function brokersFrom(configService: ConfigService<Config, true>): string[] {
  return configService
    .get('KAFKA_BROKERS', { infer: true })
    .split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
}

@Injectable()
export class RewardTrackingDlqProducer implements OnModuleDestroy {
  private readonly logger = new Logger(RewardTrackingDlqProducer.name);
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
      clientId: 'reward-tracking-service-ingest-dlq',
      brokers: brokersFrom(this.configService),
      logLevel: logLevel.NOTHING,
      // The consumer's own bounded-retry policy already owns retry/backoff decisions at the
      // message level (`reward-tracking-consumer.service.ts`) — kafkajs's internal connect/send
      // retries would compound on top unpredictably, same reasoning the sibling DLQ producer
      // documents.
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
   * Publishes one message to `reward.redemption.completed.dlq.v1`. `key` is a deterministic hash
   * of the original message's own key (the `customerId` partition key) — **never** the plaintext
   * value itself (R6, fixed post-review: an earlier version of `reward-tracking-consumer.service.ts`
   * forwarded the raw partition key verbatim; see that file's own header for the full story). `null`
   * only when the original message carried no key at all. Throws on any failure to connect or send
   * — a DLQ-publish failure must never be silently swallowed: the caller never commits the original
   * message's offset in that case, so it is redelivered rather than lost
   * (`reward-tracking-consumer.service.ts`'s own header).
   *
   * `message` is never the raw wire body containing a plaintext `customerId` field under any
   * unvalidated shape this method can rely on (R6) — the caller strips/hashes it before calling this
   * method (see that file's own `sanitizeForDlq` and its header for exactly what is preserved).
   */
  async publish(key: string | null, message: Record<string, unknown>): Promise<void> {
    await this.connect();
    if (!this.producer) {
      throw new Error('RewardTrackingDlqProducer: producer failed to connect');
    }
    try {
      await this.producer.send({
        topic: REWARD_TRACKING_COMPLETED_DLQ_TOPIC,
        messages: [{ key: key ?? undefined, value: JSON.stringify(message) }],
      });
    } catch (error) {
      this.logger.error(
        `DLQ publish failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}
