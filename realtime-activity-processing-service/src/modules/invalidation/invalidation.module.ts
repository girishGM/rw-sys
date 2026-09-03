/**
 * T-RAP-011. Imports `CampaignConfigCacheModule` (T-RAP-010, reused for its `CampaignConfigClient`
 * and `CampaignConfigCacheService` providers — no second gRPC channel/Postgres connection opened
 * here, exactly the precedent that module's own header set for a sibling in this same file-scope
 * owner's queue).
 *
 * Not imported into `AppModule` by this task — same convention `campaign-config-cache.module.ts`
 * and `idempotency.module.ts` already set: nothing transport-facing consumes this module yet. This
 * task's own startup-behaviour verification (two instances, one event, both receive it) is instead
 * proven by this module's own e2e specs, which construct a minimal harness around just these two
 * classes — see `test/modules/invalidation/*.e2e-spec.ts`.
 *
 * Every tunable in `invalidation.config.ts` is read from `ConfigService.get` without
 * `{ infer: true }` — same reasoning `outbox-publisher.module.ts` (promo-code-service) and
 * `campaign-config.client.ts`'s own header already give: each is an optional tuning knob with a
 * documented safe default, not a required secret that must extend `src/config/config.schema.ts`
 * (outside this task's file scope, R8).
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CampaignConfigCacheModule } from '../campaign-cache/campaign-config-cache.module';
import { WatchStreamConsumer } from './watch-stream.consumer';
import { ReconciliationPollerService } from './reconciliation-poller.service';
import {
  DEFAULT_RECONCILIATION_POLL_INTERVAL_MS,
  DEFAULT_WATCH_STREAM_BACKOFF_BASE_MS,
  DEFAULT_WATCH_STREAM_BACKOFF_MAX_MS,
  RECONCILIATION_POLLER_AUTOSTART,
  RECONCILIATION_POLL_INTERVAL_MS,
  WATCH_STREAM_AUTOSTART,
  WATCH_STREAM_BACKOFF_BASE_MS,
  WATCH_STREAM_BACKOFF_MAX_MS,
} from './invalidation.config';

/** Reads a positive integer env var, falling back to `fallback` when absent/invalid. */
function readPositiveIntEnv(configService: ConfigService, key: string, fallback: number): number {
  const raw = configService.get<string>(key);
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Same `NODE_ENV !== 'test'` default `OUTBOX_PUBLISHER_AUTOSTART` uses — see
 * `invalidation.config.ts`'s own header for why. */
function readAutostart(configService: ConfigService, key: string): boolean {
  const raw = configService.get<string>(key);
  if (raw !== undefined) {
    return raw === 'true';
  }
  return configService.get<string>('NODE_ENV') !== 'test';
}

@Module({
  imports: [CampaignConfigCacheModule],
  providers: [
    {
      provide: RECONCILIATION_POLL_INTERVAL_MS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): number =>
        readPositiveIntEnv(
          configService,
          'RECONCILIATION_POLL_INTERVAL_MS',
          DEFAULT_RECONCILIATION_POLL_INTERVAL_MS,
        ),
    },
    {
      provide: WATCH_STREAM_BACKOFF_BASE_MS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): number =>
        readPositiveIntEnv(
          configService,
          'WATCH_STREAM_BACKOFF_BASE_MS',
          DEFAULT_WATCH_STREAM_BACKOFF_BASE_MS,
        ),
    },
    {
      provide: WATCH_STREAM_BACKOFF_MAX_MS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): number =>
        readPositiveIntEnv(
          configService,
          'WATCH_STREAM_BACKOFF_MAX_MS',
          DEFAULT_WATCH_STREAM_BACKOFF_MAX_MS,
        ),
    },
    {
      provide: WATCH_STREAM_AUTOSTART,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): boolean =>
        readAutostart(configService, 'WATCH_STREAM_AUTOSTART'),
    },
    {
      provide: RECONCILIATION_POLLER_AUTOSTART,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): boolean =>
        readAutostart(configService, 'RECONCILIATION_POLLER_AUTOSTART'),
    },
    WatchStreamConsumer,
    ReconciliationPollerService,
  ],
  exports: [WatchStreamConsumer, ReconciliationPollerService],
})
export class InvalidationModule {}
