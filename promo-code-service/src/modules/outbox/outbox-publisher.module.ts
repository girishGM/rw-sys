/**
 * T-PC-022. Imports `PromoCodeConfigModule` (T-PC-010, reused for its `PROMO_CODE_SEQUELIZE`
 * connection pool — no second Postgres connection opened here, same convention
 * `promo-code-generation.module.ts` already established) purely for `OutboxRepository`'s DB
 * access; this module has no other dependency on config/binding domain logic.
 *
 * Every tunable in `outbox-publisher.config.ts` is read from `ConfigService.get` without
 * `{ infer: true }`, same reasoning `promo-code-generation.module.ts`'s own header gives: each is
 * an optional tuning knob with a safe documented default, not a required secret that must extend
 * `src/config/config.schema.ts` (outside this task's file scope, R8).
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PromoCodeConfigModule } from '../promo-code-config/promo-code-config.module';
import { OutboxRepository } from './outbox.repository';
import { KafkaProducerService } from './kafka-producer.service';
import { OutboxPublisherWorker } from './outbox-publisher.worker';
import {
  DEFAULT_OUTBOX_BACKOFF_BASE_MS,
  DEFAULT_OUTBOX_BACKOFF_MAX_MS,
  DEFAULT_OUTBOX_BATCH_SIZE,
  DEFAULT_OUTBOX_MAX_ATTEMPTS,
  DEFAULT_OUTBOX_POLL_INTERVAL_MS,
  OUTBOX_BACKOFF_BASE_MS,
  OUTBOX_BACKOFF_MAX_MS,
  OUTBOX_BATCH_SIZE,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_POLL_INTERVAL_MS,
  OUTBOX_PUBLISHER_AUTOSTART,
} from './outbox-publisher.config';

/** Reads a positive integer env var, falling back to `fallback` when absent/invalid. */
function readPositiveIntEnv(configService: ConfigService, key: string, fallback: number): number {
  const raw = configService.get<string>(key);
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

@Module({
  imports: [PromoCodeConfigModule],
  providers: [
    OutboxRepository,
    KafkaProducerService,
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
      provide: OUTBOX_MAX_ATTEMPTS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): number =>
        readPositiveIntEnv(configService, 'OUTBOX_MAX_ATTEMPTS', DEFAULT_OUTBOX_MAX_ATTEMPTS),
    },
    {
      provide: OUTBOX_BACKOFF_BASE_MS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): number =>
        readPositiveIntEnv(configService, 'OUTBOX_BACKOFF_BASE_MS', DEFAULT_OUTBOX_BACKOFF_BASE_MS),
    },
    {
      provide: OUTBOX_BACKOFF_MAX_MS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): number =>
        readPositiveIntEnv(configService, 'OUTBOX_BACKOFF_MAX_MS', DEFAULT_OUTBOX_BACKOFF_MAX_MS),
    },
    {
      provide: OUTBOX_PUBLISHER_AUTOSTART,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): boolean => {
        const raw = configService.get<string>('OUTBOX_PUBLISHER_AUTOSTART');
        if (raw !== undefined) {
          return raw === 'true';
        }
        // See `outbox-publisher.config.ts`'s own header: on by default, off under
        // `NODE_ENV=test` so the many *.e2e-spec.ts files across this project that boot the
        // full AppModule for unrelated reasons never race a live poller against real rows
        // another suite created.
        return configService.get<string>('NODE_ENV') !== 'test';
      },
    },
    OutboxPublisherWorker,
  ],
  exports: [OutboxPublisherWorker],
})
export class OutboxPublisherModule {}
