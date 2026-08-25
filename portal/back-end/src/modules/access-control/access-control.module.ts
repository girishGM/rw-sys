/**
 * T-033 — DI wiring for `/admin/access-control`. Follows `rules.module.ts`'s precedent (T-031)
 * exactly: `RbacModule` brings `ScopedRepository`, `PermissionCacheService`, `PERMISSION_STORE`
 * and the already-global `RolesGuard`/`PermissionsGuard`; `AuthModule` brings the four guards this
 * task's controller duplicates at class level (`JwtAuthGuard`, `SessionValidGuard`,
 * `PasswordChangeRequiredGuard`, `MfaRequiredGuard`) — see that file's header for why.
 * `DatabaseModule` supplies `SEQUELIZE`, used for the lock-and-diff transaction every write runs
 * inside.
 */
import { Module } from '@nestjs/common';
import { AuditModule } from '@/common/audit/audit.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import { DatabaseModule } from '@/database/database.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { AccessControlController } from './access-control.controller';
import { AccessControlService } from './access-control.service';

@Module({
  imports: [RbacModule, AuditModule, DatabaseModule, AuthModule],
  controllers: [AccessControlController],
  providers: [AccessControlService],
  exports: [AccessControlService],
})
export class AccessControlModule {}
