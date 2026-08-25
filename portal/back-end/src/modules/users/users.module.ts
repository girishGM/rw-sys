/**
 * T-035 — DI wiring for `/users`.
 *
 * A module file is an addition to this task's declared *Files owned* list, following the same
 * precedent `tenants.module.ts`'s own header cites (T-010…T-015/T-017/T-045/T-030/T-034).
 * `RbacModule` brings `ScopedRepository` and the already-global guard/interceptor chain;
 * `AuthModule` is imported for `CredentialService.hash()`/`changePassword()` (create + reset) and
 * `SessionService` (deactivate/reset revocation — see `users.service.ts`'s own header for why
 * this module cannot literally share the transaction those live in); `DatabaseModule` supplies
 * `SEQUELIZE` for every multi-step transaction here, including the raw parameterised credential
 * insert `insertCredential()` uses in place of `ScopedRepository` (see that method's own header).
 *
 * T-046 adds `SecurityModule` — for `THROTTLE_STORE`, the same counter store `DataProtectionModule`
 * (T-017) already imports it for — and `TemporaryPasswordService` as a provider. Not `@Global`, so
 * it has to be imported explicitly here rather than inherited; `DataProtectionModule`'s own header
 * makes the identical choice for the identical reason.
 */
import { Module } from '@nestjs/common';
import { AuditModule } from '@/common/audit/audit.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import { SecurityModule } from '@/common/security/security.module';
import { DatabaseModule } from '@/database/database.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { TemporaryPasswordService } from './services/temporary-password.service';

@Module({
  imports: [RbacModule, AuthModule, AuditModule, DatabaseModule, SecurityModule],
  controllers: [UsersController],
  providers: [UsersService, TemporaryPasswordService],
  exports: [UsersService],
})
export class UsersModule {}
