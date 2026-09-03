/**
 * T-RAP-021. Owns its own runtime Postgres connection (the least-privilege `rap_app` role,
 * `AGENT-PROTOCOL.md` R1) rather than importing `CampaignConfigCacheModule`/`EncryptionModule` for
 * their own exported `*_SEQUELIZE` tokens — same self-contained-connection precedent
 * `encryption.module.ts`'s own header already documents for exactly this reason: this task's own
 * writes (`activity_logs`) are a distinct concern from either of those modules' own tables, and
 * staying self-contained avoids a load-order coupling none of the three tasks actually needs.
 *
 * Imports `CampaignConfigCacheModule` (for `CampaignConfigCacheService`, via `ActivityMapper`),
 * `EncryptionModule` (for `EncryptionService`/`LogRedactorService`), `IdempotencyModule` (for
 * `CorrelationIdService`/`IdempotencyService`) and `ObservabilityModule` (T-RAP-058, for
 * `MetricsService`/`StructuredLoggerFactory` — `ActivityIngestionService`'s own call sites into
 * `06-CONFIGURABILITY-AND-OBSERVABILITY.md` §3) so `ActivityIngestionService` can inject all five
 * without this module also owning any of their own connections/tables.
 *
 * Not wired into `AppModule` by this task — same convention every Wave 2 module before it has set
 * (`idempotency.module.ts`, `campaign-config-cache.module.ts`, `encryption.module.ts`): nothing
 * transport-facing consumes this module yet. T-RAP-022 (gRPC) and T-RAP-023 (Kafka) both import
 * this module directly once they land (`AGENT-PROTOCOL.md` R5 — same domain method, same module,
 * from both transports).
 */
import { Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sequelize } from 'sequelize-typescript';
import type { Config } from '@/config/config.schema';
import { CampaignConfigCacheModule } from '@/modules/campaign-cache/campaign-config-cache.module';
import { EncryptionModule } from '@/modules/encryption/encryption.module';
import { IdempotencyModule } from '@/modules/idempotency/idempotency.module';
import { ObservabilityModule } from '@/observability/observability.module';
import { ActivityMapper } from './activity-mapper';
import { ActivityIngestionService } from './activity-ingestion.service';
import { ACTIVITY_MAPPING_SEQUELIZE, ActivityLogsRepository } from './activity-logs.repository';

/**
 * `ActivityMappingModule`'s own Sequelize connection pool has no built-in Nest lifecycle hook by
 * default — same leaked-connection fix `campaign-config-cache.module.ts`'s/`encryption.module.ts`'s
 * own `SequelizeShutdownHook` already document (see either file's header).
 */
@Injectable()
class SequelizeShutdownHook implements OnModuleDestroy {
  constructor(@Inject(ACTIVITY_MAPPING_SEQUELIZE) private readonly sequelize: Sequelize) {}

  async onModuleDestroy(): Promise<void> {
    await this.sequelize.close();
  }
}

@Module({
  imports: [CampaignConfigCacheModule, EncryptionModule, IdempotencyModule, ObservabilityModule],
  providers: [
    {
      provide: ACTIVITY_MAPPING_SEQUELIZE,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Config, true>): Sequelize =>
        new Sequelize({
          dialect: 'postgres',
          host: configService.get('DB_HOST', { infer: true }),
          port: configService.get('DB_PORT', { infer: true }),
          database: configService.get('DB_NAME', { infer: true }),
          username: configService.get('DB_APP_USERNAME', { infer: true }),
          password: configService.get('DB_APP_PASSWORD', { infer: true }),
          logging: false,
          dialectOptions: configService.get('DB_SSL', { infer: true })
            ? { ssl: { require: true, rejectUnauthorized: false } }
            : {},
        }),
    },
    ActivityLogsRepository,
    ActivityMapper,
    ActivityIngestionService,
    SequelizeShutdownHook,
  ],
  exports: [
    ACTIVITY_MAPPING_SEQUELIZE,
    ActivityLogsRepository,
    ActivityMapper,
    ActivityIngestionService,
  ],
})
export class ActivityMappingModule {}
