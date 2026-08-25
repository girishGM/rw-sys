/**
 * T-015 — DI wiring for `/me`.
 *
 * A module file is an addition to T-015's declared *Files owned* list, following the precedent
 * T-010…T-014 each set (`auth.module.ts`, `security.module.ts`, `rbac.module.ts`,
 * `audit.module.ts`, `errors.module.ts`); recorded as a deviation in the completion report.
 *
 * Three imports, one dependency each:
 *
 *  - **`RbacModule`** — `PermissionCacheService` (the cached matrix) and `PERMISSION_STORE` (the
 *    live `rbac_version` read the ETag needs). It also re-exports `ScopeModule`, so this is where
 *    `ScopedRepository` comes from; importing `ScopeModule` separately would work and would
 *    duplicate a dependency T-013 deliberately routes through one place.
 *  - **`MessagesModule`** — `MessageService.getAll()`, the catalogue shipped to the SPA.
 *  - **`AuditModule`** — `AuditService.annotate()` for `PATCH /me`.
 *
 * It registers **no global guard or interceptor**. Everything `/me` is protected by is already
 * global by the time this module loads (00-ARCHITECTURE.md §6, composed by `RbacModule`), which is
 * why `MeModule` can be appended to `AppModule` at any position without changing the chain.
 */
import { Module } from '@nestjs/common';
import { AuditModule } from '@/common/audit/audit.module';
import { MessagesModule } from '@/common/messages/messages.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import { BootstrapService } from './bootstrap.service';
import { MeController } from './me.controller';
import { MeService } from './me.service';

@Module({
  imports: [RbacModule, MessagesModule, AuditModule],
  controllers: [MeController],
  providers: [MeService, BootstrapService],
  exports: [MeService, BootstrapService],
})
export class MeModule {}
