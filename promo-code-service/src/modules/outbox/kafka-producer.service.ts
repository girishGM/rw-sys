/**
 * T-PC-022. Thin `kafkajs` producer wrapper — the only file in this task that imports `kafkajs`
 * directly. `ARCHITECTURE.md` §4: "KafkaJS is the de facto standard Node Kafka client... this
 * needs no bespoke wire code." No business logic lives here (R10) — this service knows nothing
 * about outbox rows, envelopes or retry/backoff policy; it only knows how to send one message to
 * one topic and throw on failure. `OutboxPublisherWorker` owns every retry/backoff/exhaustion
 * decision.
 *
 * Connects **lazily, only on the first actual `publish()` call** — deliberately not from
 * `onModuleInit` — for two reasons: implementation note 6/TC-11 ("a poll cycle with zero
 * `PENDING` rows must never open... a Kafka connection"), and so that booting `AppModule` (every
 * `*.e2e-spec.ts` in this project, plus production startup) never fails or blocks on Kafka
 * reachability — the same "a missing/unreachable broker must not surface as a mysterious
 * unrelated failure" discipline `config.schema.ts` already applies to config validation, applied
 * here to module wiring. Once connected, the connection is kept open for the life of the process.
 */
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, logLevel, type Producer } from 'kafkajs';

@Injectable()
export class KafkaProducerService implements OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducerService.name);
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
      clientId: 'promo-code-service-outbox-publisher',
      brokers,
      logLevel: logLevel.NOTHING,
      // `OutboxPublisherWorker` already owns retry/backoff policy at the row level
      // (implementation note 3) — kafkajs's own internal connect/send retries would compound
      // on top of that unpredictably, so both are disabled here and a connect/send failure
      // surfaces immediately as a single rejected promise for the worker to handle.
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
   * Publishes one message. `key` is the partition key (`02-KAFKA-CONTRACTS.md` §5: "Partition
   * key: correlationId") so a retry of the same result lands on the same partition as any prior
   * attempt. Throws on any failure to connect or send — `OutboxPublisherWorker` is the only place
   * that decides what a failure means (retry/backoff/exhaustion), never this class.
   */
  async publish(topic: string, key: string, message: Record<string, unknown>): Promise<void> {
    await this.connect();
    if (!this.producer) {
      throw new Error('KafkaProducerService: producer failed to connect');
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
