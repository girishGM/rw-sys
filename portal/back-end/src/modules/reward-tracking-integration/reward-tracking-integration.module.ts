/**
 * T-INT-030 — DI wiring for leg 8 (portal → reward-tracking-service admin dashboards).
 *
 * Imports `DatabaseModule` directly (not transitively through `RbacModule`, unlike
 * `dashboard.module.ts`) because `RewardTrackingChannelResolverService` injects `SEQUELIZE`
 * itself, the same direct-injection convention `common/rbac/permission.repository.ts` and
 * `common/messages/message.repository.ts` already establish for a small, self-contained
 * repository that isn't a `ScopedRepository` consumer (this config table has no tenancy-scoped
 * business data — see the resolver's own header for why `ScopedRepository`/R2 does not apply
 * here).
 *
 * Registers no guard, interceptor or filter of its own — `RewardTrackingDashboardController`
 * relies entirely on the already-global `JwtAuthGuard`/`RolesGuard` chain, same as
 * `dashboard.module.ts`/`DashboardController`.
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '@/database/database.module';
import { RewardTrackingAdminTokenService } from './reward-tracking-admin-token';
import { RewardTrackingChannelResolverService } from './reward-tracking-channel-resolver.service';
import { RewardTrackingRestClient } from './reward-tracking-rest.client';
import { RewardTrackingDashboardController } from './reward-tracking-dashboard.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [RewardTrackingDashboardController],
  providers: [
    RewardTrackingAdminTokenService,
    RewardTrackingChannelResolverService,
    RewardTrackingRestClient,
  ],
})
export class RewardTrackingIntegrationModule {}
