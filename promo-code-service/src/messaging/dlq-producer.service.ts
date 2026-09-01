/**
 * T-PC-030. Thin, lazy-connecting `kafkajs` producer for the DLQ topic only
 * (`02-KAFKA-CONTRACTS.md` §6) — the same lazy-connect-on-first-publish discipline
 * `modules/outbox/kafka-producer.service.ts` (T-PC-022) already established for this project (a
 * missing/unreachable broker must never surface as a mysterious unrelated failure, e.g. at boot),
 * reimplemented here rather than imported from that file because it is `agent-promo-generation`'s
 * own owned file (`project.config.json`), outside this agent's delegated scope (`src/messaging/**`
 * — AGENT-PROTOCOL.md R8/R10). No business logic lives here — this service only knows how to send
 * one message to the DLQ topic and throw on failure; `generate-requested.consumer.ts` owns every
 * retry/backoff/DLQ-routing decision.
 */
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, logLevel, type Producer } from 'kafkajs';

@Injectable()
export class DlqProducerService implements OnModuleDestroy {
  private readonly logger = new Logger(DlqProducerService.name);
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
      clientId: 'promo-code-service-generate-requested-dlq',
      brokers,
      logLevel: logLevel.NOTHING,
      // Same reasoning `kafka-producer.service.ts` documents: the consumer's own bounded-retry
      // policy already owns retry/backoff decisions at the message level — kafkajs's internal
      // connect/send retries would compound on top of that unpredictably.
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
   * Publishes one message to the DLQ. `key` is passed through as the partition key (the original
   * message's own key, per `02-KAFKA-CONTRACTS.md` §3's `correlationId`-keying convention) —
   * `null` when the original message carried no key at all (e.g. malformed-JSON case, where no
   * key can be recovered). Throws on any failure to connect or send.
   */
  async publish(
    topic: string,
    key: string | null,
    message: Record<string, unknown>,
  ): Promise<void> {
    await this.connect();
    if (!this.producer) {
      throw new Error('DlqProducerService: producer failed to connect');
    }
    try {
      await this.producer.send({
        topic,
        messages: [{ key: key ?? undefined, value: JSON.stringify(message) }],
      });
    } catch (error) {
      this.logger.error(`DLQ publish failed for topic "${topic}": ${(error as Error).message}`);
      throw error;
    }
  }
}
