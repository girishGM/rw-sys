/**
 * T-PC-042, implementation note 5: "Kafka consumer lag is read from the consumer group's own
 * committed-offset-vs-high-watermark gap ... do not approximate it by counting log lines or
 * inferring it from processing timestamps." Uses `kafkajs`'s own `Admin` client
 * (`fetchTopicOffsets` for each partition's high watermark, `fetchOffsets` for the consumer
 * group's own committed offset) — the same broker-truth source a real operator's own `kafka-
 * consumer-groups.sh --describe` would read, not a bespoke approximation.
 *
 * Reads `GENERATE_REQUESTED_TOPIC`/`GENERATE_REQUESTED_CONSUMER_GROUP` from
 * `src/messaging/kafka-consumer.config.ts` (T-PC-030, read-only import — this task never edits
 * that file, R8) since the lag this service needs to report is specifically *this* consumer
 * group's own lag on *this* topic, not a generic multi-topic lag reporter.
 *
 * Connects lazily on first scrape (same "never open a broker connection just from module
 * construction" discipline `kafka-producer.service.ts`/T-PC-022 already established for this
 * project) and never throws back to the `/metrics` caller — a broker outage should make this one
 * gauge read `0`/stale, per this task's own "graceful, no scrape failure" philosophy already
 * applied to the outbox backlog gauge (TC-7), not take the whole `/metrics` endpoint down.
 */
import { Kafka, logLevel, type Admin } from 'kafkajs';
import {
  GENERATE_REQUESTED_CONSUMER_GROUP,
  GENERATE_REQUESTED_TOPIC,
} from '../../messaging/kafka-consumer.config';

export class KafkaConsumerLagProvider {
  private admin: Admin | null = null;
  private connecting: Promise<Admin> | null = null;

  constructor(
    private readonly brokers: string[],
    private readonly logger: { warn: (message: string) => void },
  ) {}

  private async getAdmin(): Promise<Admin> {
    if (this.admin) {
      return this.admin;
    }
    if (this.connecting) {
      return this.connecting;
    }
    const kafka = new Kafka({
      clientId: 'promo-code-service-metrics-admin',
      brokers: this.brokers,
      logLevel: logLevel.NOTHING,
      retry: { retries: 0 },
      connectionTimeout: 2_000,
    });
    const admin = kafka.admin();
    this.connecting = admin
      .connect()
      .then(() => {
        this.admin = admin;
        return admin;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  async disconnect(): Promise<void> {
    const admin = this.admin;
    this.admin = null;
    if (admin) {
      await admin.disconnect();
    }
  }

  /**
   * Sum of `max(0, highWatermark - committedOffset)` across every partition of
   * `GENERATE_REQUESTED_TOPIC` for `GENERATE_REQUESTED_CONSUMER_GROUP`. A partition with no
   * committed offset yet (kafkajs reports `"-1"`) contributes `0` — "no consumer has ever
   * committed on this partition" is a startup transient, not a lag figure to report.
   */
  async getLag(): Promise<number> {
    try {
      const admin = await this.getAdmin();
      const [topicOffsets, groupOffsets] = await Promise.all([
        admin.fetchTopicOffsets(GENERATE_REQUESTED_TOPIC),
        admin.fetchOffsets({
          groupId: GENERATE_REQUESTED_CONSUMER_GROUP,
          topics: [GENERATE_REQUESTED_TOPIC],
        }),
      ]);
      const committedByPartition = new Map<number, string>();
      for (const groupTopic of groupOffsets) {
        for (const partitionOffset of groupTopic.partitions) {
          committedByPartition.set(partitionOffset.partition, partitionOffset.offset);
        }
      }
      let totalLag = 0;
      for (const partitionOffset of topicOffsets) {
        const committed = committedByPartition.get(partitionOffset.partition);
        if (committed === undefined || committed === '-1') {
          continue;
        }
        // `.high` is the partition's own high watermark (next offset to be produced) —
        // more explicit than reusing the same-shaped `.offset` field for this purpose.
        const lag = Number(partitionOffset.high) - Number(committed);
        totalLag += Math.max(0, lag);
      }
      return totalLag;
    } catch (error) {
      this.logger.warn(
        `KafkaConsumerLagProvider: could not compute consumer lag, reporting 0: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }
}
