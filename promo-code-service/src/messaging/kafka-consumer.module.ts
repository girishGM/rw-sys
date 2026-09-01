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
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PromoCodeGenerationModule } from '../modules/generation/promo-code-generation.module';
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
  imports: [PromoCodeGenerationModule],
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
