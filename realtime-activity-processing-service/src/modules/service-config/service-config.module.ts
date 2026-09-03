/**
 * T-RAP-013. Not wired into `AppModule` by this task — same convention `idempotency.module.ts`
 * (T-RAP-020), `campaign-config-cache.module.ts` (T-RAP-010) and `encryption.module.ts`
 * (T-RAP-012) already set (see their own headers): nothing transport-facing consumes this module
 * yet. Owns its own Postgres connection (the least-privilege `rap_app` role, AGENT-PROTOCOL.md
 * R1) rather than importing `CampaignConfigCacheModule` for its exported
 * `CAMPAIGN_CACHE_SEQUELIZE` — this task's own `Depends on` is only T-RAP-002, not T-RAP-010,
 * and staying self-contained avoids a load-order coupling neither task actually needs (identical
 * reasoning to `encryption.module.ts`'s own header).
 *
 * Exports `ServiceConfigResolverService` and `ServiceConfigRepository` so later Wave 2/3 tasks
 * (T-RAP-011's own poll interval, T-RAP-033/034's retry-attempt caps) can import this module
 * directly, matching the precedent `campaign-config-cache.module.ts`'s own header already set for
 * its sibling exports.
 */
import { Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sequelize } from 'sequelize-typescript';
import type { Config } from '@/config/config.schema';
import { ServiceConfigResolverService } from './service-config-resolver.service';
import { SERVICE_CONFIG_SEQUELIZE, ServiceConfigRepository } from './service-config.repository';

/**
 * `ServiceConfigModule`'s own Sequelize connection pool has no built-in Nest lifecycle hook by
 * default — same leaked-connection fix `campaign-config-cache.module.ts`'s own
 * `SequelizeShutdownHook` already documents (see that file's header).
 */
@Injectable()
class SequelizeShutdownHook implements OnModuleDestroy {
  constructor(@Inject(SERVICE_CONFIG_SEQUELIZE) private readonly sequelize: Sequelize) {}

  async onModuleDestroy(): Promise<void> {
    await this.sequelize.close();
  }
}

@Module({
  providers: [
    {
      provide: SERVICE_CONFIG_SEQUELIZE,
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
    ServiceConfigRepository,
    ServiceConfigResolverService,
    SequelizeShutdownHook,
  ],
  exports: [SERVICE_CONFIG_SEQUELIZE, ServiceConfigRepository, ServiceConfigResolverService],
})
export class ServiceConfigModule {}
