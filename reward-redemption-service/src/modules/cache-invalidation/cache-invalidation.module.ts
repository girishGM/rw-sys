/**
 * T-RR-007. Wires the `POST /api/v1/cache/invalidate` surface: imports `TenantSchemaCacheModule`
 * for four of the five real caches, and provides this module's own guard/service/audit repository.
 *
 * Registered directly in `AppModule`'s imports (append-only) — see
 * `tenant-schema-cache.module.ts`'s own header for why this task registers eagerly rather than
 * deferring the way `ClaimWorkerModule` currently is.
 *
 * **T-RR-054**: also imports `ProcessingModule` (`agent-rr-processing`'s own file scope, T-RR-022)
 * for its exported `CampaignConfigCache` — the fifth cache. This is a plain, non-circular import
 * (`ProcessingModule` does not import this module back), so it needs no `forwardRef`. Deferred
 * until now because `ProcessingModule` didn't actually compile under Nest's real DI container
 * before T-RR-055 fixed `CampaignConfigClient`/`CampaignConfigCache`'s constructors — see
 * `cache-invalidation.service.ts`'s own header for the routing this now enables.
 *
 * **T-RR-060**: also imports `ObservabilityModule` for `MetricsRegistry` — `CacheInvalidationService`
 * now increments `cache_invalidation_total{key}` on every successfully processed request, matching
 * every other module that already wires this same registry.
 */
import { Module } from '@nestjs/common';
import { TenantSchemaCacheModule } from '@/modules/tenant-schema-cache/tenant-schema-cache.module';
import { ProcessingModule } from '@/modules/processing/processing.module';
import { ObservabilityModule } from '@/observability/observability.module';
import { CacheAdminAuthGuard } from './cache-admin-auth.guard';
import { CacheInvalidationAuditRepository } from './cache-invalidation-audit.repository';
import { CacheInvalidationController } from './cache-invalidation.controller';
import { CacheInvalidationService } from './cache-invalidation.service';

@Module({
  imports: [TenantSchemaCacheModule, ProcessingModule, ObservabilityModule],
  controllers: [CacheInvalidationController],
  providers: [CacheInvalidationService, CacheInvalidationAuditRepository, CacheAdminAuthGuard],
})
export class CacheInvalidationModule {}
