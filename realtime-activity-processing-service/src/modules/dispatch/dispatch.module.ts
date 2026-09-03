/**
 * T-RAP-034. Wires the three-tier reward-dispatch chain (`05-PROCESSING-PIPELINE.md` §7):
 * `OutboxPublisherService` (tiers 1-2) and `RewardDispatchRetryWorker` (tier 3).
 *
 * Imports `ProcessingModule` purely to reuse its exported `PROCESSING_SEQUELIZE` connection pool
 * (`reward-entry-outbox.repository.ts`'s own header: "avoid opening a second Postgres pool for a
 * table this small") rather than opening a dedicated one of its own — none of this module's own
 * calls pass a `Transaction` in, so this never participates in, or blocks on, the processing
 * pipeline's own transactions (`05-PROCESSING-PIPELINE.md` §7: "outside the domain transaction").
 * Imports `EncryptionModule` (`EncryptionService`, R4's decrypt-at-publish boundary) and
 * `ServiceConfigModule` (`ServiceConfigResolverService`, `dispatch.config.ts`'s own
 * `reward_dispatch_max_retry_attempts` resolution).
 *
 * **Not wired into `AppModule`** — same convention every prior Wave 1-3 module in this project has
 * set (nothing transport-facing/handler-providing exists yet to consume it as part of full app
 * boot; `RuleEvaluationRowHandler`'s own extension of this task, in `modules/processing/**`, is
 * the only current caller of `RewardEntryRepository`/`RewardEntryOutboxRepository`'s transactional
 * insert path — the dispatch tiers here are a separate, independently-pollable concern).
 *
 * **T-RAP-059 update:** imports `ObservabilityModule` (T-RAP-043) so `MetricsService`/
 * `StructuredLoggerFactory` resolve for `OutboxPublisherService`/`RewardDispatchRetryWorker` —
 * both constructors gained these two as new, non-optional parameters (`reward_dispatch_tier_total`
 * + structured logging, `06-CONFIGURABILITY-AND-OBSERVABILITY.md` §3). Importing `ProcessingModule`
 * above already re-exports nothing observability-related, so this is a direct import here, not
 * inherited transitively.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EncryptionModule } from '@/modules/encryption/encryption.module';
import { ServiceConfigModule } from '@/modules/service-config/service-config.module';
import { ObservabilityModule } from '@/observability/observability.module';
import { ProcessingModule } from '@/modules/processing/processing.module';
import { RewardEntryRepository } from '@/modules/reward-entry/reward-entry.repository';
import { RewardEntryOutboxRepository } from '@/modules/reward-entry/reward-entry-outbox.repository';
import { RewardDispatchRetryRepository } from './reward-dispatch-retry.repository';
import { RewardKafkaProducerClient } from './reward-kafka-producer.client';
import {
  RewardGrpcFallbackClient,
  loadRewardGrpcFallbackClientOptions,
} from './reward-grpc-fallback.client';
import { OutboxPublisherService } from './outbox-publisher.service';
import { RewardDispatchRetryWorker } from './reward-dispatch-retry.worker';
import {
  DEFAULT_OUTBOX_BATCH_SIZE,
  DEFAULT_OUTBOX_POLL_INTERVAL_MS,
  DEFAULT_RETRY_BACKOFF_BASE_MS,
  DEFAULT_RETRY_BACKOFF_MAX_MS,
  DEFAULT_RETRY_BATCH_SIZE,
  DEFAULT_RETRY_WORKER_POLL_INTERVAL_MS,
  OUTBOX_BATCH_SIZE,
  OUTBOX_POLL_INTERVAL_MS,
  OUTBOX_PUBLISHER_AUTOSTART,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  RETRY_BATCH_SIZE,
  RETRY_WORKER_AUTOSTART,
  RETRY_WORKER_POLL_INTERVAL_MS,
} from './dispatch.config';

/** Reads a positive integer env var, falling back to `fallback` when absent/invalid — same helper
 * `promo-code-service`'s own `outbox-publisher.module.ts` (T-PC-022) established for its sibling. */
function readPositiveIntEnv(configService: ConfigService, key: string, fallback: number): number {
  const raw = configService.get<string>(key);
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

@Module({
  imports: [ProcessingModule, EncryptionModule, ServiceConfigModule, ObservabilityModule],
  providers: [
    RewardEntryRepository,
    RewardEntryOutboxRepository,
    RewardDispatchRetryRepository,
    RewardKafkaProducerClient,
    {
      // Not Nest's implicit constructor-injection: `RewardGrpcFallbackClient`'s own constructor
      // parameter is a plain options interface, not a class — same reasoning
      // `campaign-config-cache.module.ts`'s own `CampaignConfigClient` factory provider documents.
      provide: RewardGrpcFallbackClient,
      useFactory: (): RewardGrpcFallbackClient =>
        new RewardGrpcFallbackClient(loadRewardGrpcFallbackClientOptions()),
    },
    {
      provide: OUTBOX_POLL_INTERVAL_MS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): number =>
        readPositiveIntEnv(
          configService,
          'OUTBOX_POLL_INTERVAL_MS',
          DEFAULT_OUTBOX_POLL_INTERVAL_MS,
        ),
    },
    {
      provide: OUTBOX_BATCH_SIZE,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): number =>
        readPositiveIntEnv(configService, 'OUTBOX_BATCH_SIZE', DEFAULT_OUTBOX_BATCH_SIZE),
    },
    {
      provide: RETRY_WORKER_POLL_INTERVAL_MS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): number =>
        readPositiveIntEnv(
          configService,
          'REWARD_DISPATCH_RETRY_POLL_INTERVAL_MS',
          DEFAULT_RETRY_WORKER_POLL_INTERVAL_MS,
        ),
    },
    {
      provide: RETRY_BATCH_SIZE,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): number =>
        readPositiveIntEnv(
          configService,
          'REWARD_DISPATCH_RETRY_BATCH_SIZE',
          DEFAULT_RETRY_BATCH_SIZE,
        ),
    },
    {
      provide: RETRY_BACKOFF_BASE_MS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): number =>
        readPositiveIntEnv(
          configService,
          'REWARD_DISPATCH_RETRY_BACKOFF_BASE_MS',
          DEFAULT_RETRY_BACKOFF_BASE_MS,
        ),
    },
    {
      provide: RETRY_BACKOFF_MAX_MS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): number =>
        readPositiveIntEnv(
          configService,
          'REWARD_DISPATCH_RETRY_BACKOFF_MAX_MS',
          DEFAULT_RETRY_BACKOFF_MAX_MS,
        ),
    },
    {
      provide: OUTBOX_PUBLISHER_AUTOSTART,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): boolean => {
        const raw = configService.get<string>('OUTBOX_PUBLISHER_AUTOSTART');
        if (raw !== undefined) {
          return raw === 'true';
        }
        // Same "off under NODE_ENV=test" precedent `promo-code-service`'s own
        // `outbox-publisher.module.ts` set (see that file's header): this project's many
        // *.e2e-spec.ts files boot real modules for unrelated reasons, and a live poller racing a
        // real, globally-shared `reward_entry_outbox` table another suite is using would be exactly
        // the kind of cross-test nondeterminism AGENT-PROTOCOL.md warns against.
        return configService.get<string>('NODE_ENV') !== 'test';
      },
    },
    {
      provide: RETRY_WORKER_AUTOSTART,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): boolean => {
        const raw = configService.get<string>('RETRY_WORKER_AUTOSTART');
        if (raw !== undefined) {
          return raw === 'true';
        }
        return configService.get<string>('NODE_ENV') !== 'test';
      },
    },
    OutboxPublisherService,
    RewardDispatchRetryWorker,
  ],
  exports: [
    RewardEntryRepository,
    RewardEntryOutboxRepository,
    RewardDispatchRetryRepository,
    OutboxPublisherService,
    RewardDispatchRetryWorker,
  ],
})
export class DispatchModule {}
