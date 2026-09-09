/**
 * T-RTS-020. Owns this module's own runtime Postgres connection — no shared application-level
 * `DatabaseModule` exists yet anywhere in `src/` (matches
 * `realtime-activity-processing-service/src/modules/campaign-cache/campaign-config-cache.module.ts`'s
 * own precedent and its header's explanation of why). Connects as the least-privilege
 * `reward_tracking_app` role (`DB_APP_*`, AGENT-PROTOCOL.md R2), never the migration role
 * `src/database/migration-connection.ts` uses.
 *
 * Not imported into `AppModule` by this task, same convention that sibling precedent set: nothing
 * transport-facing consumes this module's cache yet. T-RTS-031 (Wave 3, depends on this task)
 * imports this module directly once it lands, the same way T-RAP-021 imports
 * `CampaignConfigCacheModule` on the RAP side. This task's own startup-behaviour verification
 * (TC-1..3) is instead proven by this module's own client/repository specs, which construct the
 * real classes directly against a mock portal + real Postgres — see
 * `test/campaign-cache/campaign-hierarchy.client.spec.ts`.
 *
 * Exports `CAMPAIGN_CACHE_SEQUELIZE`, `CampaignHierarchyCacheRepository` and
 * `CampaignHierarchyClient` so T-RTS-031 (same "second consumer" data this task builds) can import
 * this module and reuse the connection/client instead of opening a second one.
 */
import { Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sequelize } from 'sequelize-typescript';
import type { Config } from '@/config/config.schema';
import {
  CampaignHierarchyClient,
  loadCampaignHierarchyClientOptions,
} from './campaign-hierarchy.client';
import {
  CAMPAIGN_CACHE_SEQUELIZE,
  CampaignHierarchyCacheRepository,
} from './campaign-hierarchy-cache.repository';

/**
 * `CampaignHierarchyClient`'s own `onModuleDestroy` closes its grpc-js channel; this class does
 * the same for the Sequelize connection pool — nothing implements a Nest lifecycle interface on a
 * plain `Sequelize` instance by default, so without this a shutdown never closes this pool. Same
 * fix `realtime-activity-processing-service`'s own `campaign-config-cache.module.ts` already
 * documents (`SequelizeShutdownHook`).
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
    CampaignHierarchyCacheRepository,
    {
      // Not Nest's implicit constructor-injection: `CampaignHierarchyClient`'s first constructor
      // parameter is a plain options interface, not a class, which Nest's `design:paramtypes`
      // reflection cannot resolve to a DI token. A factory sidesteps that entirely — see that
      // file's own header for the client's config-loading contract this factory calls.
      provide: CampaignHierarchyClient,
      inject: [CampaignHierarchyCacheRepository],
      useFactory: (repository: CampaignHierarchyCacheRepository): CampaignHierarchyClient =>
        new CampaignHierarchyClient(loadCampaignHierarchyClientOptions(), repository),
    },
    SequelizeShutdownHook,
  ],
  exports: [CAMPAIGN_CACHE_SEQUELIZE, CampaignHierarchyCacheRepository, CampaignHierarchyClient],
})
export class CampaignCacheModule {}
