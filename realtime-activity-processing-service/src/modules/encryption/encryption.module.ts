/**
 * T-RAP-012. Not wired into `AppModule` by this task — same convention `idempotency.module.ts`
 * (T-RAP-020) and `campaign-config-cache.module.ts` (T-RAP-010) already set (see their own
 * headers): nothing transport-facing consumes this module yet. Owns its own Postgres connection
 * (the least-privilege `rap_app` role, AGENT-PROTOCOL.md R1) rather than importing
 * `CampaignConfigCacheModule` for its exported `CAMPAIGN_CACHE_SEQUELIZE` — this task's own
 * `Depends on` is only T-RAP-001/T-RAP-002, not T-RAP-010, and staying self-contained avoids a
 * load-order coupling neither task actually needs.
 *
 * Exports `EncryptionService`, `FieldEncryptionConfigRepository` and `LogRedactorService` so
 * later Wave 2/3 tasks (ingestion, processing) can import this module directly, matching the
 * precedent `campaign-config-cache.module.ts`'s own header already set for its sibling exports.
 */
import { Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sequelize } from 'sequelize-typescript';
import type { Config } from '@/config/config.schema';
import { EncryptionService, loadEncryptionKeyMaterial } from './encryption.service';
import {
  ENCRYPTION_SEQUELIZE,
  FieldEncryptionConfigRepository,
} from './field-encryption-config.repository';
import { LogRedactorService } from './log-redactor.service';

/**
 * `EncryptionModule`'s own Sequelize connection pool has no built-in Nest lifecycle hook by
 * default — same leaked-connection fix `campaign-config-cache.module.ts`'s own
 * `SequelizeShutdownHook` already documents (see that file's header).
 */
@Injectable()
class SequelizeShutdownHook implements OnModuleDestroy {
  constructor(@Inject(ENCRYPTION_SEQUELIZE) private readonly sequelize: Sequelize) {}

  async onModuleDestroy(): Promise<void> {
    await this.sequelize.close();
  }
}

@Module({
  providers: [
    {
      provide: ENCRYPTION_SEQUELIZE,
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
    {
      // Not Nest's implicit constructor-injection: `EncryptionService`'s own constructor
      // parameter is a plain `EncryptionKeyMaterial` interface, not a class, which Nest's
      // `design:paramtypes` reflection cannot resolve to a DI token — and `loadEncryptionKeyMaterial()`'s
      // throw-on-missing-env-var (TC-7) must happen eagerly, at module-construction time, exactly
      // like `CampaignConfigClient`'s own factory provider (see that module's header for the
      // identical reasoning).
      provide: EncryptionService,
      useFactory: (): EncryptionService => new EncryptionService(loadEncryptionKeyMaterial()),
    },
    FieldEncryptionConfigRepository,
    LogRedactorService,
    SequelizeShutdownHook,
  ],
  exports: [
    ENCRYPTION_SEQUELIZE,
    EncryptionService,
    FieldEncryptionConfigRepository,
    LogRedactorService,
  ],
})
export class EncryptionModule {}
