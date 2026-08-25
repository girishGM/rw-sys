/**
 * T-040 — DI wiring for `/audit/campaigns` and `/audit/portal`.
 *
 * Named `AuditViewerModule`, not `AuditModule` — `common/audit/audit.module.ts` (T-014) already
 * exports a class of that name for the *write* side (`AuditService`, `AuditInterceptor`); reusing
 * the identifier here would collide on import and blur the "T-040 reads, T-014 writes" boundary
 * this module's own controller header explains. `RbacModule` and `AuditModule` are both imported:
 * the former for `ScopedRepository`, `RolesGuard`/`PermissionsGuard`'s decorators, and the
 * `Roles`/`RequirePermission` metadata this module's controller declares; the latter for the
 * `@Audit()` decorator on the two sensitive GETs — the same pair `trace.module.ts` imports for
 * the same two reasons.
 */
import { Module } from '@nestjs/common';
import { AuditModule } from '@/common/audit/audit.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import { AuditViewerController } from './audit-viewer.controller';
import { AuditViewerService } from './audit-viewer.service';

@Module({
  imports: [RbacModule, AuditModule],
  controllers: [AuditViewerController],
  providers: [AuditViewerService],
})
export class AuditViewerModule {}
