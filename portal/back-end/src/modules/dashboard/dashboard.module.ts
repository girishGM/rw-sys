/**
 * T-092 — DI wiring for `/dashboard/*`.
 *
 * A module file is an addition to this task's declared *Files owned* list, following the
 * precedent every other Wave 3/4 feature module's own header cites (most recently
 * `merchant-portal.module.ts`, T-039). `RbacModule` brings `ScopedRepository` and the already-
 * global guard chain — nothing here registers a guard, interceptor or filter of its own.
 * `TenantsModule` and `MerchantPortalModule` are imported for the two services this module
 * deliberately reuses rather than re-derives (`dashboard.service.ts`'s own header, "Reuse over
 * re-derivation"); neither is imported for anything beyond that one exported service each.
 */
import { Module } from '@nestjs/common';
import { RbacModule } from '@/common/rbac/rbac.module';
import { MerchantPortalModule } from '@/modules/merchant-portal/merchant-portal.module';
import { TenantsModule } from '@/modules/tenants/tenants.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [RbacModule, TenantsModule, MerchantPortalModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
