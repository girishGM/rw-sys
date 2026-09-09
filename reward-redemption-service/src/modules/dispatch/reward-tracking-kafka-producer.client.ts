/**
 * T-RR-034. Thin `kafkajs` producer wrapper for `reward.redemption.completed.v1`
 * (`02-KAFKA-CONTRACTS.md` §2) — the only file in this module that imports `kafkajs` directly,
 * same isolation RAP's own `reward-kafka-producer.client.ts` establishes for its sibling producer
 * (confirmed by direct read, ported here rather than imported: that file lives under
 * `realtime-activity-processing-service/src/modules/dispatch/`, a different service's own file
 * scope, R0). No business logic lives here (R10) — `OutboxPublisherService` owns every
 * retry/backoff/tier decision; this class only knows how to send one message to one topic and
 * throw on failure.
 *
 * Connects **lazily, only on the first actual `publish()` call** — a poll cycle with nothing to
 * publish must never open a Kafka connection, and booting a module that provides this class must
 * never fail or block on Kafka reachability (`ARCHITECTURE.md` §9/`02-KAFKA-CONTRACTS.md` §4: "a
 * production broker is not assumed to exist at all").
 *
 * **T-RR-035 extends this same file** (both tasks are `agent-rr-integration`'s own) with
 * `KafkaBrokerUnreachableError` — the distinguishable, transport-level failure
 * `OutboxPublisherService` needs to tell apart from an ordinary per-message publish failure
 * (T-RR-035 implementation note 4: "distinguish 'broker unreachable' ... from 'this one publish
 * failed for message-specific reasons'"). Thrown whenever `connect()` itself fails (there is no
 * connection to a broker at all yet) or `producer.send()` fails with kafkajs's own
 * `KafkaJSConnectionError` (the connection dropped mid-flight) — both are the same "the broker
 * itself is unreachable" condition `ARCHITECTURE.md` §9 describes, as opposed to a per-message
 * rejection that leaves the connection itself healthy.
 */
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, KafkaJSConnectionError, logLevel, type Producer } from 'kafkajs';
import type { Config } from '@/config/config.schema';

/**
 * T-RR-035. A transport-level "the broker itself is unreachable" failure — never a per-message
 * publish rejection. `OutboxPublisherService` catches this specifically to trigger an immediate
 * REST fallback attempt, bypassing its own normal multi-cycle Kafka-attempts-before-fallback
 * threshold entirely (implementation note 4).
 */
export class KafkaBrokerUnreachableError extends Error {
  constructor(cause: unknown) {
    super(`Kafka broker unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'KafkaBrokerUnreachableError';
  }
}

/** `02-KAFKA-CONTRACTS.md` §2's own topic name — also `reward_tracking_dispatch_outbox.topic`'s
 * own column `DEFAULT` (`01-DATABASE.md` §7), so this constant and that default must never drift
 * independently of one another. */
export const REWARD_TRACKING_COMPLETED_TOPIC = 'reward.redemption.completed.v1';

/** The one method `OutboxPublisherService` actually needs — narrow enough that a unit test can
 * substitute a plain fake object instead of standing up a real `kafkajs` connection (mirrors every
 * other narrow structural port in this service, e.g. `dispatch.config.ts`'s
 * `DispatchServiceConfigResolver`). */
export interface RewardTrackingKafkaProducerPort {
  publish(topic: string, key: string, message: Record<string, unknown>): Promise<void>;
}

@Injectable()
export class RewardTrackingKafkaProducerClient
  implements RewardTrackingKafkaProducerPort, OnModuleDestroy
{
  private readonly logger = new Logger(RewardTrackingKafkaProducerClient.name);
  private producer: Producer | null = null;
  private connecting: Promise<void> | null = null;

  constructor(private readonly config: ConfigService<Config, true>) {}

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
    const brokers = this.config
      .get('KAFKA_BROKERS', { infer: true })
      .split(',')
      .map((broker) => broker.trim())
      .filter((broker) => broker.length > 0);
    const kafka = new Kafka({
      clientId: 'reward-redemption-service-dispatch',
      brokers,
      logLevel: logLevel.NOTHING,
      // `OutboxPublisherService` already owns retry/backoff/attempts-based tier decisions at the
      // row level (`dispatch.config.ts`) — `kafkajs`'s own internal connect/send retries would
      // compound on top of that unpredictably, same reasoning RAP's own producer documents.
      retry: { retries: 0 },
      connectionTimeout: 3_000,
    });
    const producer = kafka.producer();
    this.connecting = producer
      .connect()
      .then(() => {
        this.producer = producer;
      })
      .catch((error: unknown) => {
        // T-RR-035: there is no connection to any broker at all yet — always a broker-unreachable
        // condition, never a per-message failure (there is no message in flight here).
        throw new KafkaBrokerUnreachableError(error);
      })
      .finally(() => {
        this.connecting = null;
      });
    await this.connecting;
  }

  /**
   * Publishes one message, partitioned by `key` (`02-KAFKA-CONTRACTS.md` §2's own "partition key:
   * `customerId`" note — a throughput/ordering convenience, never a duplicate-delivery guarantee,
   * per that section's own explicit statement). Throws on any failure to connect or send; the
   * caller is the only place that decides what a failure means (attempts/backoff/tier-fallthrough,
   * never this class, per R10).
   */
  async publish(topic: string, key: string, message: Record<string, unknown>): Promise<void> {
    try {
      await this.connect();
    } catch (error) {
      this.logger.warn(
        `Kafka connect failed ahead of publishing to topic "${topic}": ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
    if (!this.producer) {
      throw new Error('RewardTrackingKafkaProducerClient: producer failed to connect');
    }
    try {
      await this.producer.send({
        topic,
        messages: [{ key, value: JSON.stringify(message) }],
      });
    } catch (error) {
      // R8: never log `key`/`message` here — both may carry the plaintext `customerId` this
      // publisher was handed at the point of publish. The caller (`OutboxPublisherService`) logs
      // its own warning without either value.
      this.logger.warn(
        `Kafka publish failed for topic "${topic}": ${error instanceof Error ? error.message : String(error)}`,
      );
      // T-RR-035: a connection dropped mid-flight is the same "broker unreachable" condition as a
      // failure to ever connect in the first place (`connect()` above) — re-thrown as the same
      // distinguishable type so `OutboxPublisherService` can tell it apart from a per-message
      // rejection that leaves the connection itself healthy.
      if (error instanceof KafkaJSConnectionError) {
        throw new KafkaBrokerUnreachableError(error);
      }
      throw error;
    }
  }
}
