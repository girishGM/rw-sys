/**
 * T-RAP-034. Thin `kafkajs` producer wrapper for the Kafka dispatch tier (tier 1,
 * `05-PROCESSING-PIPELINE.md` §7 point 1) — the only file in this module that imports `kafkajs`
 * directly, same isolation `promo-code-service`'s own `kafka-producer.service.ts` and this
 * service's own `messaging/ingest/activity-ingest.consumer.ts` (`ActivityIngestDlqPublisher`)
 * already establish for their sibling producers. No business logic lives here (R5's spirit, R10) —
 * `OutboxPublisherService`/`RewardDispatchRetryWorker` own every retry/backoff/tier decision; this
 * class only knows how to send one message to one topic and throw on failure.
 *
 * Reimplemented here rather than importing `messaging/ingest/activity-ingest.consumer.ts`'s own
 * `ActivityIngestDlqPublisher` — that file is outside this task's file scope (`src/messaging/**`
 * belongs to T-RAP-023/`agent-rap-ingestion`), and, per that class's own header, this exact
 * "reimplement rather than share" choice is this project's own established precedent (the DLQ
 * publisher's header cites the identical reasoning for not importing `promo-code-service`'s own
 * producer).
 *
 * Connects **lazily, only on the first actual `publish()` call** — same reasoning
 * `promo-code-service`'s own `KafkaProducerService` documents: a poll cycle with nothing to publish
 * must never open a Kafka connection, and booting a module that imports this class must never fail
 * or block on Kafka reachability.
 */
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, logLevel, type Producer } from 'kafkajs';

@Injectable()
export class RewardKafkaProducerClient implements OnModuleDestroy {
  private readonly logger = new Logger(RewardKafkaProducerClient.name);
  private producer: Producer | null = null;
  private connecting: Promise<void> | null = null;

  constructor(private readonly configService: ConfigService) {}

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
    const brokers = String(this.configService.get<string>('KAFKA_BROKERS') ?? '')
      .split(',')
      .map((broker) => broker.trim())
      .filter(Boolean);
    const kafka = new Kafka({
      clientId: 'realtime-activity-processing-service-reward-dispatch',
      brokers,
      logLevel: logLevel.NOTHING,
      // `OutboxPublisherService`/`RewardDispatchRetryWorker` already own retry/backoff policy at
      // the row level — kafkajs's own internal connect/send retries would compound on top of that
      // unpredictably, same reasoning every prior producer in this project already documents.
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

  /** Publishes one message. Throws on any failure to connect or send — the caller is the only
   * place that decides what a failure means (retry/backoff/tier-fallthrough), never this class. */
  async publish(topic: string, key: string, message: Record<string, unknown>): Promise<void> {
    await this.connect();
    if (!this.producer) {
      throw new Error('RewardKafkaProducerClient: producer failed to connect');
    }
    try {
      await this.producer.send({
        topic,
        messages: [{ key, value: JSON.stringify(message) }],
      });
    } catch (error) {
      this.logger.warn(`Kafka publish failed for topic "${topic}": ${(error as Error).message}`);
      throw error;
    }
  }
}
