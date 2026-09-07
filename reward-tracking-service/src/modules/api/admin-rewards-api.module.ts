/**
 * T-RTS-031. Wires `AdminRewardsController` + its three query services onto this module's own
 * runtime Postgres connection — same "no shared application-level `DatabaseModule` exists yet"
 * situation `customer-rewards-api.module.ts` (T-RTS-030) already documents for its own table, and
 * the identical fix: this module owns its own connection. `PortalAdminAuthModule` is imported
 * directly for `PortalAdminAuthGuard` (`auth.module.ts`'s own header — split into one module per
 * guard specifically so importing this module never also drags in `CustomerAuthGuard`'s own,
 * unrelated secret requirement, and vice versa).
 *
 * Not listed in this task's own "Files owned" — same situation `customer-rewards-api.module.ts`
 * itself was in for T-RTS-030 (also absent from that task's own file list, see that file's own
 * header): a module wiring file is an unavoidable implementation necessity to give this task's
 * controller an actual DI graph, not a second controller/service this task wasn't asked to build.
 *
 * Registered into `AppModule`'s own append-only import list (R10 — "registration points ...
 * are append-only"), alongside `CustomerRewardsApiModule`.
 *
 * `LoggingModule` (T-RTS-040, `src/observability/**`) is imported directly, same precedent
 * `customer-rewards-api.module.ts` already documents for its own use of `ApiObservabilityInterceptor`
 * (T-RTS-050) — one shared interceptor class reused verbatim across both API surfaces, each module
 * providing its own instance through its own DI container.
 */
import { Module } from '@nestjs/common';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sequelize } from 'sequelize-typescript';
import type { Config } from '@/config/config.schema';
import { PortalAdminAuthModule } from '@/modules/auth/auth.module';
import { LoggingModule } from '@/observability/logging.module';
import { AdminRewardsController } from './admin-rewards.controller';
import {
  ADMIN_REWARDS_SEQUELIZE,
  CampaignSummaryQueryService,
} from './campaign-summary-query.service';
import { CountedLevelQueryService } from './counted-level-query.service';
import { AlertsQueryService } from './alerts-query.service';
import { ApiObservabilityInterceptor } from './api-observability.interceptor';

/** Closes the Sequelize connection pool on shutdown — same fix `campaign-cache.module.ts`'s own
 * `SequelizeShutdownHook` / `customer-rewards-api.module.ts`'s own equivalent already document. */
@Injectable()
class AdminRewardsSequelizeShutdownHook implements OnModuleDestroy {
  constructor(@Inject(ADMIN_REWARDS_SEQUELIZE) private readonly sequelize: Sequelize) {}

  async onModuleDestroy(): Promise<void> {
    await this.sequelize.close();
  }
}

@Module({
  imports: [PortalAdminAuthModule, LoggingModule],
  controllers: [AdminRewardsController],
  providers: [
    ApiObservabilityInterceptor,
    {
      provide: ADMIN_REWARDS_SEQUELIZE,
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
    CampaignSummaryQueryService,
    CountedLevelQueryService,
    AlertsQueryService,
    AdminRewardsSequelizeShutdownHook,
  ],
})
export class AdminRewardsApiModule {}
