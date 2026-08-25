/**
 * T-036 — DI wiring for `/merchants`.
 *
 * A module file is an addition to this task's declared *Files owned* list, the same precedent
 * `tenants.module.ts`'s own header cites. `RbacModule` brings `ScopedRepository` and the
 * already-global guard/interceptor chain; `AuthModule` is imported for `SessionService`
 * (implementation note 8's bulk revoke — see `merchants.service.ts`'s own header for why this
 * module cannot reach the transaction that lives inside it); `DatabaseModule` supplies
 * `SEQUELIZE` for every multi-step transaction here.
 */
import { Module } from '@nestjs/common';
import { AuditModule } from '@/common/audit/audit.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import { DatabaseModule } from '@/database/database.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { MerchantsController } from './merchants.controller';
import { MerchantsService } from './merchants.service';

@Module({
  imports: [RbacModule, AuthModule, AuditModule, DatabaseModule],
  controllers: [MerchantsController],
  providers: [MerchantsService],
  exports: [MerchantsService],
})
export class MerchantsModule {}
