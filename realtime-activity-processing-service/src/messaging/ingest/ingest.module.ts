/**
 * T-RAP-023. Wires the Kafka transport adapter's own providers. Imports `ActivityMappingModule`
 * (T-RAP-021, exported `ActivityIngestionService`) rather than duplicating it — same "no second
 * copy of the domain service" convention `src/grpc/grpc.module.ts` (T-RAP-022) already established
 * for this project's other ingestion transport.
 *
 * `RETRY_BACKOFF_BASE_MS`/`RETRY_BACKOFF_MAX_MS` are read from `ConfigService.get` without
 * `{ infer: true }` — same reasoning `invalidation.module.ts` (T-RAP-011) gives: each is an
 * optional tuning knob with a documented safe default, not a required secret that must extend
 * `src/config/config.schema.ts` (outside this task's file scope, R8).
 *
 * Not imported into `AppModule` by this task — `src/app.module.ts` is `agent-rap-foundation`'s own
 * file scope, not this agent's (`project.config.json`), same reasoning `grpc.module.ts`'s own
 * header gives for why T-RAP-022 ships its own standalone composition root
 * (`activity-ingest-consumer.main.ts`, this task's own equivalent) instead of editing that file.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActivityMappingModule } from '@/modules/activity-mapping/activity-mapping.module';
import { ActivityIngestConsumer, ActivityIngestDlqPublisher } from './activity-ingest.consumer';
import {
  DEFAULT_RETRY_BACKOFF_BASE_MS,
  DEFAULT_RETRY_BACKOFF_MAX_MS,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
} from './ingest.config';

/** Reads a positive integer env var, falling back to `fallback` when absent/invalid. */
function readPositiveIntEnv(configService: ConfigService, key: string, fallback: number): number {
  const raw = configService.get<string>(key);
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

@Module({
  imports: [ActivityMappingModule],
  providers: [
    ActivityIngestDlqPublisher,
    {
      provide: RETRY_BACKOFF_BASE_MS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): number =>
        readPositiveIntEnv(
          configService,
          'ACTIVITY_INGEST_RETRY_BACKOFF_BASE_MS',
          DEFAULT_RETRY_BACKOFF_BASE_MS,
        ),
    },
    {
      provide: RETRY_BACKOFF_MAX_MS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): number =>
        readPositiveIntEnv(
          configService,
          'ACTIVITY_INGEST_RETRY_BACKOFF_MAX_MS',
          DEFAULT_RETRY_BACKOFF_MAX_MS,
        ),
    },
    ActivityIngestConsumer,
  ],
  exports: [ActivityIngestConsumer, ActivityIngestDlqPublisher],
})
export class IngestModule {}
