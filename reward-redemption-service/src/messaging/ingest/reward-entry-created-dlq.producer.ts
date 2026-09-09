/**
 * T-RR-012. Lazy-connecting kafkajs producer for `reward.entry.created.dlq.v1`
 * (`02-KAFKA-CONTRACTS.md` §1's own DLQ-policy paragraph) — schema-invalid messages only, **never**
 * a duplicate `id` (R6; `reward-entry-created.consumer.ts`'s own header has the full reasoning).
 * Same lazy-connect-on-first-publish discipline `promo-code-service`'s own
 * `dlq-producer.service.ts` and RAP's own `ActivityIngestDlqPublisher` (T-RAP-023, confirmed by
 * direct read) already established for this repo: a missing/unreachable broker must never surface
 * as a mysterious failure at boot, only at the point a DLQ publish is actually attempted.
 *
 * No business logic lives here — only "send one message to the DLQ topic and throw on failure".
 * `RewardEntryCreatedConsumer` owns every retry/backoff/DLQ-routing decision (R10's "no business
 * logic in a transport adapter" applied here to the DLQ leg of that same adapter).
 */
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import type { Config } from '@/config/config.schema';

/** `02-KAFKA-CONTRACTS.md` §1. */
export const REWARD_ENTRY_CREATED_DLQ_TOPIC = 'reward.entry.created.dlq.v1';

function brokersFrom(configService: ConfigService<Config, true>): string[] {
  return configService
    .get('KAFKA_BROKERS', { infer: true })
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean);
}

@Injectable()
export class RewardEntryCreatedDlqProducer implements OnModuleDestroy {
  private readonly logger = new Logger(RewardEntryCreatedDlqProducer.name);
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
      clientId: 'reward-redemption-service-ingest-dlq',
      brokers: brokersFrom(this.configService),
      logLevel: logLevel.NOTHING,
      // The consumer's own bounded-retry policy already owns retry/backoff decisions at the
      // message level (`reward-entry-created.consumer.ts`) — kafkajs's internal connect/send
      // retries would compound on top unpredictably, same reasoning RAP's own DLQ publisher
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
   * Publishes one message to `reward.entry.created.dlq.v1`. `key` is the original message's own
   * key (the `customerId` partition key, `null` only when the original message carried no key at
   * all). Throws on any failure to connect or send — a DLQ-publish failure must never be silently
   * swallowed (see `reward-entry-created.consumer.ts`'s own header for what that causes: the whole
   * message is redelivered rather than lost).
   */
  async publish(key: string | null, message: Record<string, unknown>): Promise<void> {
    await this.connect();
    if (!this.producer) {
      throw new Error('RewardEntryCreatedDlqProducer: producer failed to connect');
    }
    try {
      await this.producer.send({
        topic: REWARD_ENTRY_CREATED_DLQ_TOPIC,
        messages: [{ key: key ?? undefined, value: JSON.stringify(message) }],
      });
    } catch (error) {
      this.logger.error(`DLQ publish failed: ${(error as Error).message}`);
      throw error;
    }
  }
}
