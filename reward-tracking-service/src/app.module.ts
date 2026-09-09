import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { CustomerRewardsApiModule } from './modules/api/customer-rewards-api.module';
import { AdminRewardsApiModule } from './modules/api/admin-rewards-api.module';
import { CampaignCacheModule } from './modules/campaign-cache/campaign-cache.module';

/**
 * Append-only registration point, same convention as the portal's and every sibling service's own
 * `app.module.ts`: each task adds its own module import line here and touches nothing else in this
 * file, so two agents working in parallel (Wave 1 onward) never collide on this file's content.
 *
 * T-INT-005 adds `CampaignCacheModule` (T-RTS-020) — the first real consumer of that module, per
 * its own header's own note that this was always the intended follow-up. Unlike `main.ts`'s three
 * transport mains (separate application instances, attached in `main.ts` itself), this module has
 * no listener of its own — it needs to be part of `AppModule`'s DI graph to run at all, so it's a
 * plain import here, the same way `TenantSchemaCacheModule`/`CacheInvalidationModule` are eagerly
 * registered in `reward-redemption-service`'s own `AppModule` (T-RR-007's precedent). Its own
 * `CampaignHierarchyClient.onModuleInit()` never gates or crashes this process — an unreachable or
 * unconfigured portal degrades to a stale/empty `campaign_hierarchy_cache`, logged, never thrown
 * (that class's own header, R1) — so importing it unconditionally here does not change Render's
 * current REST-only deploy behavior until `PORTAL_GRPC_HOST`/`PORTAL_CONFIG_TENANT_IDS` are
 * actually set there.
 */
@Module({
  imports: [
    ConfigModule,
    HealthModule,
    CustomerRewardsApiModule,
    AdminRewardsApiModule,
    CampaignCacheModule,
  ],
})
export class AppModule {}
