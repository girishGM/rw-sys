/**
 * T-030 — DI wiring for `/countries`.
 *
 * A module file is an addition to this task's declared *Files owned* list, following the
 * precedent T-010…T-015/T-017/T-045 each set with their own module files (`scope.module.ts`'s
 * header lists the chain); recorded as a deviation in the completion report.
 *
 * `RbacModule` brings `ScopedRepository` (via its re-exported `ScopeModule`) and the already-
 * global `RolesGuard`/`PermissionsGuard`/`TenancyScopeInterceptor` — nothing here registers a
 * guard or interceptor of its own, since every one this module needs is already composed by
 * 00-ARCHITECTURE.md §6 by the time `AppModule` reaches this import. `AuthModule` is imported for
 * `CredentialService.hash()` alone, the same Argon2id parameters `CredentialService.authenticate`
 * verifies against. `DatabaseModule` supplies `SEQUELIZE` for the create/admin transaction.
 */
import { Module } from '@nestjs/common';
import { AuditModule } from '@/common/audit/audit.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import { DatabaseModule } from '@/database/database.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { CountriesController } from './countries.controller';
import { CountriesService } from './countries.service';

@Module({
  imports: [RbacModule, AuthModule, AuditModule, DatabaseModule],
  controllers: [CountriesController],
  providers: [CountriesService],
  exports: [CountriesService],
})
export class CountriesModule {}
