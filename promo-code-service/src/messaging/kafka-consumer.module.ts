/**
 * T-PC-030. Wires the Kafka transport adapter's own providers. Imports
 * `PromoCodeGenerationModule` (T-PC-021, exported `PromoCodeGenerationService`) rather than
 * duplicating it — same "no second copy of the domain service" convention `grpc-server.module.ts`
 * (T-PC-031) already established for this project's transport adapters.
 *
 * `RETRY_BACKOFF_BASE_MS`/`RETRY_BACKOFF_MAX_MS` are read from `ConfigService.get` without
 * `{ infer: true }`, same reasoning `outbox-publisher.module.ts` (T-PC-022) gives: each is an
 * optional tuning knob with a safe documented default, not a required secret that must extend
 * `src/config/config.schema.ts` (outside this task's file scope, R8).
 *
 * **T-PC-047.** Also imports `LoggingModule` (`src/observability/logging/logging.module.ts`, owned
 * by `agent-promo-qa`/T-PC-042 — a `Read`, not an `Edit`, of that file). Same fix, same reasoning as
 * `grpc-server.module.ts`'s own T-PC-047 note: this is the standalone Kafka consumer's own separate
 * `NestFactory` DI container (`KafkaConsumerRootModule`, `kafka-consumer.main.ts`), which never ran
 * `Logger.overrideLogger(...)` before this change, and every place this module is bootstrapped
 * directly — `KafkaConsumerRootModule` *and* `generate-requested.consumer.e2e-spec.ts`'s own
 * `Test.createTestingModule({ imports: [ConfigModule, KafkaConsumerModule] })` — gets the identical
 * wiring from one import here, with nothing left to duplicate in `kafka-consumer.main.ts` itself.
 * `LoggingModule` also exports `CorrelationContextService`, which `GenerateRequestedConsumer` now
 * injects to run each message inside `CorrelationContextService.run(...)`.
 *
 * **T-PC-048.** Also imports `MetricsModule` (`src/observability/metrics/metrics.module.ts`, owned
 * by `agent-promo-qa`/T-PC-042 — a `Read`, not an `Edit`, of that file, same precedent this
 * module's own T-PC-047 note already set for `LoggingModule`). Same fix, same reasoning as
 * `grpc-server.module.ts`'s own T-PC-048 note: before this change, `GenerationLatencyInstrumentation`
 * never wrapped this process's own `PromoCodeGenerationService` instance, so
 * `codes_generated_total`/`promo_code_generation_duration_seconds` never moved for the real Kafka
 * generation path this process alone actually serves in production. Exposing this process's own
 * `GET /metrics` HTTP endpoint is `kafka-consumer.main.ts`'s own T-PC-048 change, not this module's.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PromoCodeGenerationModule } from '../modules/generation/promo-code-generation.module';
import { LoggingModule } from '../observability/logging/logging.module';
import { MetricsModule } from '../observability/metrics/metrics.module';
import { DlqProducerService } from './dlq-producer.service';
import { GenerateRequestedConsumer } from './generate-requested.consumer';
import {
  DEFAULT_RETRY_BACKOFF_BASE_MS,
  DEFAULT_RETRY_BACKOFF_MAX_MS,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
} from './kafka-consumer.config';

/** Reads a positive integer env var, falling back to `fallback` when absent/invalid. */
function readPositiveIntEnv(configService: ConfigService, key: string, fallback: number): number {
  const raw = configService.get<string>(key);
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

@Module({
  imports: [PromoCodeGenerationModule, LoggingModule, MetricsModule],
  providers: [
    DlqProducerService,
    {
      provide: RETRY_BACKOFF_BASE_MS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): number =>
        readPositiveIntEnv(
          configService,
          'KAFKA_CONSUMER_RETRY_BACKOFF_BASE_MS',
          DEFAULT_RETRY_BACKOFF_BASE_MS,
        ),
    },
    {
      provide: RETRY_BACKOFF_MAX_MS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): number =>
        readPositiveIntEnv(
          configService,
          'KAFKA_CONSUMER_RETRY_BACKOFF_MAX_MS',
          DEFAULT_RETRY_BACKOFF_MAX_MS,
        ),
    },
    GenerateRequestedConsumer,
  ],
  exports: [GenerateRequestedConsumer],
})
export class KafkaConsumerModule {}
