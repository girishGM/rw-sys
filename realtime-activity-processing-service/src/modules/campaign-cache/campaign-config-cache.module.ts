/**
 * T-RAP-010. Owns this module's own runtime Postgres connection — no shared application-level
 * `DatabaseModule` exists yet anywhere in `src/` (matches `promo-code-config.module.ts`'s own
 * precedent and its header's explanation of why). Connects as the least-privilege `rap_app` role
 * (`DB_APP_*`, AGENT-PROTOCOL.md R1), never the migration role `src/database/migration-connection.ts`
 * uses.
 *
 * Not imported into `AppModule` by this task — same convention `idempotency.module.ts` (T-RAP-020)
 * already set: nothing transport-facing consumes this module yet. T-RAP-021 (Wave 2) imports this
 * module directly once it lands. This task's own startup-behaviour verification steps (TC-1..3,
 * "start the app against the mock portal") are instead proven by this module's own e2e specs,
 * which construct a minimal Nest application context around just this module — see
 * `test/modules/campaign-cache/*.e2e-spec.ts`.
 *
 * Exports `CampaignConfigCacheService`, `CampaignConfigClient` and `CAMPAIGN_CACHE_SEQUELIZE` so a
 * sibling module in this same file-scope owner's queue — `invalidation` (T-RAP-011) and
 * `service-config` (T-RAP-013) — can import this module and reuse the connection/client instead
 * of opening a second one, exactly the precedent `promo-code-config.module.ts` set for
 * `campaign-binding` importing `PromoCodeConfigModule`.
 */
import { Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sequelize } from 'sequelize-typescript';
import type { Config } from '@/config/config.schema';
import { CampaignConfigClient, loadCampaignConfigClientOptions } from './campaign-config.client';
import { CampaignConfigCacheService } from './campaign-config-cache.service';
import {
  ActivityExternalCodeMapRepository,
  CAMPAIGN_CACHE_SEQUELIZE,
  CampaignConfigSnapshotRepository,
} from './campaign-config-snapshot.repository';

/**
 * `CampaignConfigClient`'s own `OnModuleDestroy` closes its grpc-js channel; this class does the
 * same for the Sequelize connection pool. Same leaked-connection fix
 * `promo-code-config.module.ts`'s own `SequelizeShutdownHook` already documents (see that file's
 * header) — nothing implements a Nest lifecycle interface on a plain `Sequelize` instance by
 * default, so without this, an owning Nest application's shutdown never closes this pool.
 */
@Injectable()
class SequelizeShutdownHook implements OnModuleDestroy {
  constructor(@Inject(CAMPAIGN_CACHE_SEQUELIZE) private readonly sequelize: Sequelize) {}

  async onModuleDestroy(): Promise<void> {
    await this.sequelize.close();
  }
}

@Module({
  providers: [
    {
      provide: CAMPAIGN_CACHE_SEQUELIZE,
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
      // Not Nest's implicit constructor-injection: `CampaignConfigClient`'s own constructor
      // parameter is a plain options interface, not a class, which Nest's `design:paramtypes`
      // reflection cannot resolve to a DI token. A factory sidesteps that entirely — see that
      // file's own header for the client's config-loading contract this factory calls.
      provide: CampaignConfigClient,
      useFactory: (): CampaignConfigClient =>
        new CampaignConfigClient(loadCampaignConfigClientOptions()),
    },
    CampaignConfigSnapshotRepository,
    ActivityExternalCodeMapRepository,
    CampaignConfigCacheService,
    SequelizeShutdownHook,
  ],
  exports: [
    CAMPAIGN_CACHE_SEQUELIZE,
    CampaignConfigClient,
    CampaignConfigSnapshotRepository,
    ActivityExternalCodeMapRepository,
    CampaignConfigCacheService,
  ],
})
export class CampaignConfigCacheModule {}
