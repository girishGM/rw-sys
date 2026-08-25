/**
 * T-039 — DI wiring for `/merchant/*`.
 *
 * A module file is an addition to this task's declared *Files owned* list, the same precedent
 * `merchants.module.ts`/`audit-viewer.module.ts` cite for their own tasks. `RbacModule` brings
 * `ScopedRepository`, `@Roles`/`@RequirePermission` metadata support and the already-global
 * guard chain; nothing else is needed — this module writes nothing (no `AuditModule`, no
 * `DatabaseModule`/`SEQUELIZE`, no transaction).
 */
import { Module } from '@nestjs/common';
import { RbacModule } from '@/common/rbac/rbac.module';
import { MerchantPortalController } from './merchant-portal.controller';
import { MerchantPortalService } from './merchant-portal.service';

@Module({
  imports: [RbacModule],
  controllers: [MerchantPortalController],
  providers: [MerchantPortalService],
  exports: [MerchantPortalService],
})
export class MerchantPortalModule {}
