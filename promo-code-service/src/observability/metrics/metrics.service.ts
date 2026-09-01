/**
 * T-PC-042. The operator-facing metrics this service needs to run in production (Objective):
 * codes generated/sec (via `codes_generated_total`, a counter — rate is a `rate()` query away,
 * standard Prometheus practice, not something this service pre-computes), generation latency
 * p50/p95/p99 (via a histogram — same reasoning, `histogram_quantile()` at query time),
 * Kafka consumer lag, and outbox backlog depth (implementation note 4: "a live gauge, not a
 * one-time count" — both queried fresh on every `render()` call, never cached).
 */
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { PROMO_CODE_SEQUELIZE } from '../../modules/promo-code-config/promo-code-config.constants';
import type { Config } from '../../config/config.schema';
import { StructuredLoggerService } from '../logging/structured-logger.service';
import { Counter, Gauge, Histogram } from './metrics-primitives';
import { KafkaConsumerLagProvider } from './kafka-consumer-lag.provider';

/** `02-KAFKA-CONTRACTS.md`/`03-GRPC-CONTRACT.md` — the two transports this counter labels by. */
export type GenerationTransport = 'KAFKA' | 'GRPC';
export type GenerationOutcome = 'SUCCESS' | 'FAILED';

/**
 * Seconds — matches this project's own generation-retry-loop reality (typically single-digit
 * milliseconds, occasionally slower under collision retries, implementation note 6: "a retry-
 * heavy request should show up as slower").
 */
const GENERATION_LATENCY_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

interface OutboxBacklogRow {
  pending_count: string;
  oldest_pending_age_seconds: number | null;
}

@Injectable()
export class MetricsService implements OnModuleDestroy {
  private readonly codesGeneratedTotal = new Counter(
    'promo_code_codes_generated_total',
    'Total promo codes generated, labelled by transport and outcome.',
    ['transport', 'outcome'],
  );

  private readonly generationDurationSeconds = new Histogram(
    'promo_code_generation_duration_seconds',
    'PromoCodeGenerationService.generateCode() latency, inclusive of collision retries.',
    GENERATION_LATENCY_BUCKETS_SECONDS,
    ['transport'],
  );

  private readonly outboxPendingCount = new Gauge(
    'promo_code_outbox_pending_count',
    'Current count of promo_code_outbox rows with status = PENDING.',
  );

  private readonly outboxOldestPendingAgeSeconds = new Gauge(
    'promo_code_outbox_oldest_pending_age_seconds',
    'Age in seconds of the oldest PENDING promo_code_outbox row, 0 when none are pending.',
  );

  private readonly kafkaConsumerLag = new Gauge(
    'promo_code_kafka_consumer_lag',
    'generate.requested consumer group lag (high watermark minus committed offset, summed across partitions).',
  );

  private readonly lagProvider: KafkaConsumerLagProvider;

  constructor(
    @Inject(PROMO_CODE_SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly configService: ConfigService<Config, true>,
    private readonly logger: StructuredLoggerService,
  ) {
    const brokers = this.configService
      .get('KAFKA_BROKERS', { infer: true })
      .split(',')
      .map((broker) => broker.trim())
      .filter(Boolean);
    this.lagProvider = new KafkaConsumerLagProvider(brokers, {
      warn: (message) => this.logger.warn(message, MetricsService.name),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.lagProvider.disconnect();
  }

  /** Called by (or on behalf of) `PromoCodeGenerationService.generateCode()`'s own call sites. */
  incrementCodesGenerated(transport: GenerationTransport, outcome: GenerationOutcome): void {
    this.codesGeneratedTotal.inc({ transport, outcome });
  }

  /** `durationMs` — converted to seconds here, Prometheus's own exposition convention. */
  recordGenerationLatency(durationMs: number, transport: GenerationTransport): void {
    this.generationDurationSeconds.observe(durationMs / 1000, { transport });
  }

  /**
   * Implementation note 4: queried fresh from `promo_code.promo_code_outbox` on every call —
   * `COUNT(*) WHERE status = 'PENDING'` and the oldest `PENDING` row's age, in one round trip.
   * TC-7: zero `PENDING` rows must read `0`/`0`, never error or read as absent.
   */
  private async refreshOutboxBacklog(): Promise<void> {
    const rows = await this.sequelize.query<OutboxBacklogRow>(
      `SELECT COUNT(*) AS pending_count,
              EXTRACT(EPOCH FROM (now() - MIN(created_at))) AS oldest_pending_age_seconds
         FROM promo_code.promo_code_outbox
        WHERE status = 'PENDING'`,
      { type: QueryTypes.SELECT },
    );
    const row = rows[0];
    const pendingCount = row ? Number(row.pending_count) : 0;
    const oldestAgeSeconds = row?.oldest_pending_age_seconds ?? 0;
    this.outboxPendingCount.set(pendingCount);
    this.outboxOldestPendingAgeSeconds.set(oldestAgeSeconds);
  }

  private async refreshKafkaConsumerLag(): Promise<void> {
    const lag = await this.lagProvider.getLag();
    this.kafkaConsumerLag.set(lag);
  }

  /** Full Prometheus text-exposition-format scrape body (TC-12). */
  async render(): Promise<string> {
    await Promise.all([this.refreshOutboxBacklog(), this.refreshKafkaConsumerLag()]);
    return (
      [
        this.codesGeneratedTotal.toPrometheus(),
        this.generationDurationSeconds.toPrometheus(),
        this.outboxPendingCount.toPrometheus(),
        this.outboxOldestPendingAgeSeconds.toPrometheus(),
        this.kafkaConsumerLag.toPrometheus(),
      ].join('\n') + '\n'
    );
  }
}
