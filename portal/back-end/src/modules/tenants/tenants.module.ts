/**
 * T-034 — DI wiring for `/tenants`.
 *
 * A module file is an addition to this task's declared *Files owned* list, following the same
 * precedent `countries.module.ts`'s own header cites (T-010…T-015/T-017/T-045/T-030). `RbacModule`
 * brings `ScopedRepository` and the already-global guard/interceptor chain; `AuthModule` is
 * imported for `CredentialService.hash()` (Tenant Admin onboarding) and `SessionService`
 * (implementation note 8's bulk revoke — see `tenants.service.ts`'s own header for why this
 * module cannot reach the transaction that lives inside it); `DatabaseModule` supplies
 * `SEQUELIZE` for every multi-step transaction here.
 */
import { Module } from '@nestjs/common';
import { AuditModule } from '@/common/audit/audit.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import { DatabaseModule } from '@/database/database.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  imports: [RbacModule, AuthModule, AuditModule, DatabaseModule],
  controllers: [TenantsController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
