/**
 * T-PC-010. Owns this module's own runtime Postgres connection — no shared application-level
 * `DatabaseModule` exists yet anywhere in `src/` (`promo-code-config.constants.ts`'s header
 * explains why this module builds its own rather than waiting on one). Connects as the
 * least-privilege `promo_code_app` role (`DB_APP_*`, AGENT-PROTOCOL.md R1), never the migration
 * role `src/database/migration-connection.ts` uses.
 *
 * Exported (`PROMO_CODE_SEQUELIZE`, `PromoCodeConfigRepository`, `PromoCodeConfigService`) so
 * the sibling `campaign-binding` module (T-PC-012, same file-scope owner) can import this module
 * and reuse both the connection pool and the config-lookup service instead of duplicating either.
 *
 * T-PC-011 adds `PromoCodeConfigController` (the portal-facing REST surface,
 * `04-API-CONTRACT.md` §1/§3) as this module's only controller, plus
 * `InternalServiceTokenStartupCheck` (that file's own header explains why it lives here rather
 * than as an append to `config.schema.ts`) and `SequelizeShutdownHook` below — no change to the
 * connection/export list above was needed for that task.
 *
 * `SequelizeShutdownHook`: T-PC-010's own `PROMO_CODE_SEQUELIZE` factory returns a plain
 * `Sequelize` instance, which implements no Nest lifecycle interface — so nothing previously
 * closed its connection pool when the owning Nest application shut down. That never surfaced
 * before this task because every earlier test either built `PromoCodeConfigRepository`/
 * `PromoCodeConfigService` directly against its own short-lived `Sequelize` connection (closed
 * explicitly in each spec's own `afterAll`, see `test/config/promo-code-config.service.spec.ts`)
 * or booted `AppModule` without ever routing a real query through the DI-managed instance
 * (`test/health.e2e-spec.ts`'s `/health` check is a raw TCP probe, not a Sequelize query). This
 * task's own controller/e2e specs are the first to do both — boot the full `AppModule` *and*
 * exercise it with real queries — which is what actually exposed the leaked pool (observed as
 * Jest's "A worker process has failed to exit gracefully" warning and one flaky failure under
 * parallel workers). Fixed here, in this already-owned file, rather than filed as a separate
 * defect against a `done` T-PC-010, since no other agent's file needed touching to fix it.
 */
import { Injectable, Module, type OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sequelize } from 'sequelize-typescript';
import type { Config } from '@/config/config.schema';
import { PROMO_CODE_SEQUELIZE } from './promo-code-config.constants';
import { PromoCodeConfigRepository } from './promo-code-config.repository';
import { PromoCodeConfigAuditRepository } from './promo-code-config-audit.repository';
import { PromoCodeConfigService } from './promo-code-config.service';
import { PromoCodeConfigController } from './promo-code-config.controller';
import { InternalServiceTokenStartupCheck } from './internal-service-token-startup-check.provider';

@Injectable()
class SequelizeShutdownHook implements OnModuleDestroy {
  constructor(@Inject(PROMO_CODE_SEQUELIZE) private readonly sequelize: Sequelize) {}

  async onModuleDestroy(): Promise<void> {
    await this.sequelize.close();
  }
}

@Module({
  controllers: [PromoCodeConfigController],
  providers: [
    {
      provide: PROMO_CODE_SEQUELIZE,
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
    PromoCodeConfigRepository,
    PromoCodeConfigAuditRepository,
    PromoCodeConfigService,
    InternalServiceTokenStartupCheck,
    SequelizeShutdownHook,
  ],
  exports: [
    PROMO_CODE_SEQUELIZE,
    PromoCodeConfigRepository,
    PromoCodeConfigAuditRepository,
    PromoCodeConfigService,
  ],
})
export class PromoCodeConfigModule {}
