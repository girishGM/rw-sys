/**
 * T-RR-007. Wires the four caches this task owns (`tenantSchemaConfig`,
 * `externalRewardSystemConfig`, `dispatchChannelConfig`, `serviceConfig`), their own repositories,
 * and `ReconciliationPollerService`, and exports the four caches so `CacheInvalidationModule`
 * (`../cache-invalidation/`) and any later Wave 2+ consumer (T-RR-022/T-RR-023/T-RR-033) can import
 * this module directly.
 *
 * Imports `ServiceConfigModule` (T-RR-006) rather than re-declaring `ServiceConfigRepository`/
 * `ServiceConfigResolverService` here — `ServiceConfigCache` wraps that module's own resolver.
 *
 * Registered directly in `AppModule`'s imports (append-only, same convention `EncryptionModule`
 * already established): the invalidation endpoint this module backs is meant to be live and
 * curl-able against a real running dev instance from this task's own verification step 2 onward,
 * not deferred the way `ClaimWorkerModule` currently is.
 */
import { Module } from '@nestjs/common';
import { ServiceConfigModule } from '@/modules/service-config/service-config.module';
import { DispatchChannelConfigCache } from './dispatch-channel-config.cache';
import { DispatchChannelConfigRepository } from './dispatch-channel-config.repository';
import { ExternalRewardSystemConfigCache } from './external-reward-system-config.cache';
import { ExternalRewardSystemConfigRepository } from './external-reward-system-config.repository';
import { ReconciliationPollerService } from './reconciliation-poller.service';
import { ServiceConfigCache } from './service-config.cache';
import { TenantSchemaConfigCache } from './tenant-schema-config.cache';
import { TenantSchemaConfigRepository } from './tenant-schema-config.repository';

@Module({
  imports: [ServiceConfigModule],
  providers: [
    TenantSchemaConfigRepository,
    ExternalRewardSystemConfigRepository,
    DispatchChannelConfigRepository,
    ServiceConfigCache,
    TenantSchemaConfigCache,
    ExternalRewardSystemConfigCache,
    DispatchChannelConfigCache,
    ReconciliationPollerService,
  ],
  exports: [
    ServiceConfigCache,
    TenantSchemaConfigCache,
    ExternalRewardSystemConfigCache,
    DispatchChannelConfigCache,
  ],
})
export class TenantSchemaCacheModule {}
