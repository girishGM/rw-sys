/**
 * T-RTS-030. Wires `CustomerRewardsController` + its two query/repository classes + a factory-built
 * `CustomerIdCryptoService` onto this module's own runtime Postgres connection (no shared
 * application-level `DatabaseModule` exists yet — same situation `campaign-cache.module.ts`
 * documents for its own table). `CustomerAuthModule` is imported directly for `CustomerAuthGuard`
 * (`auth.module.ts`'s own header — split into one module per guard specifically so importing this
 * module never also drags in `PortalAdminAuthGuard`'s own, unrelated secret requirement).
 *
 * `CustomerIdCryptoService` is provided via a factory, not plain constructor injection, for the
 * identical reason `reward-tracking-ingestion.module.ts` already documents for its own use of the
 * same class: its constructor parameter is a plain `CustomerIdCryptoKeyMaterial` interface, not a
 * class, so Nest's `design:paramtypes` reflection can't resolve it to a DI token on its own, and
 * `loadCustomerIdCryptoKeyMaterial()`'s throw-on-missing-env-var must happen eagerly, at
 * module-construction time (R6/R12) — this module builds its **own** instance rather than importing
 * `RewardTrackingIngestionModule` (which exports only `RewardTrackingIngestionService`, not this
 * class) purely to reuse a provider; the class itself is stateless (a thin wrapper over two `Buffer`
 * keys), so a second instance costs nothing and avoids taking on that whole module's own ingestion
 * surface as a dependency of this one's read-only API.
 *
 * Registered into `AppModule`'s own append-only import list (R10 — "registration points ... are
 * append-only") by this task, since this is the first task to give this service an actual
 * HTTP-reachable controller.
 *
 * `LoggingModule` (T-RTS-040, `src/observability/**`) is imported directly, per that module's own
 * header precedent ("later tasks import this module directly") — it feeds `ApiObservabilityInterceptor`
 * (T-RTS-050) the `MetricsService`/`StructuredLoggerFactory` it needs. `ApiObservabilityInterceptor`
 * is listed as its own provider here (not instantiated bare via `@UseInterceptors`) so Nest resolves
 * its constructor dependencies through this module's own DI container, same convention
 * `RewardTrackingIngestTokenGuard` already sets for a `@UseGuards(SomeClass)` reference elsewhere in
 * this codebase.
 */
import { Module } from '@nestjs/common';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sequelize } from 'sequelize-typescript';
import type { Config } from '@/config/config.schema';
import {
  CustomerIdCryptoService,
  loadCustomerIdCryptoKeyMaterial,
} from '@/modules/ingestion/customer-id-crypto.service';
import { CustomerAuthModule } from '@/modules/auth/auth.module';
import { LoggingModule } from '@/observability/logging.module';
import { CustomerRewardsController } from './customer-rewards.controller';
import {
  CUSTOMER_REWARDS_SEQUELIZE,
  CustomerRewardLedgerQueryService,
} from './customer-reward-ledger-query.service';
import { CustomerRewardBalanceRepository } from './customer-reward-balance.repository';
import { ApiObservabilityInterceptor } from './api-observability.interceptor';

/** Closes the Sequelize connection pool on shutdown — nothing implements a Nest lifecycle interface
 * on a plain `Sequelize` instance by default (same fix `campaign-cache.module.ts`'s own
 * `SequelizeShutdownHook` documents). */
@Injectable()
class CustomerRewardsSequelizeShutdownHook implements OnModuleDestroy {
  constructor(@Inject(CUSTOMER_REWARDS_SEQUELIZE) private readonly sequelize: Sequelize) {}

  async onModuleDestroy(): Promise<void> {
    await this.sequelize.close();
  }
}

@Module({
  imports: [CustomerAuthModule, LoggingModule],
  controllers: [CustomerRewardsController],
  providers: [
    ApiObservabilityInterceptor,
    {
      provide: CUSTOMER_REWARDS_SEQUELIZE,
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
    CustomerRewardLedgerQueryService,
    CustomerRewardBalanceRepository,
    {
      provide: CustomerIdCryptoService,
      useFactory: (): CustomerIdCryptoService =>
        new CustomerIdCryptoService(loadCustomerIdCryptoKeyMaterial()),
    },
    CustomerRewardsSequelizeShutdownHook,
  ],
})
export class CustomerRewardsApiModule {}
