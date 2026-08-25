/**
 * T-014 — `AuditService`, its store, and the registration of `AuditInterceptor` as position 11
 * of the 00-ARCHITECTURE.md §6 chain.
 *
 * ### Position is set by import order, not by this file
 *
 * Nest registers `APP_INTERCEPTOR` providers in module-resolution order, which follows
 * `AppModule`'s `imports` array. `RbacModule` re-exports `ScopeModule`, which registers
 * `TenancyScopeInterceptor` (position 9); this module must therefore be imported **after**
 * `RbacModule` for the audit interceptor to run inside the scope context rather than around it.
 * Appending it at the end of that array — which is what 05-EXECUTION-PLAN.md §3 asks every task
 * to do anyway — produces the right order. Do not move it earlier.
 *
 * `AuditService` is exported for the three consumers that call it directly: Wave 3 services
 * (`annotate`, `diffFields`), `ErrorNormalizationFilter` (`recordRequestFailure`), and T-040's
 * audit viewer, which reads rather than writes.
 *
 * A module addition to T-014's declared *Files owned* list, per the precedent set by
 * `security.module.ts` and `rbac.module.ts`; recorded in the completion report.
 */
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { DatabaseModule } from '@/database/database.module';
import { AuditInterceptor } from './audit.interceptor';
import { AUDIT_STORE, AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';

@Module({
  imports: [DatabaseModule],
  providers: [
    { provide: AUDIT_STORE, useClass: AuditRepository },
    AuditService,
    AuditInterceptor,
    // --- 00-ARCHITECTURE.md §6, position 11 ----------------------------------------------
    { provide: APP_INTERCEPTOR, useExisting: AuditInterceptor },
  ],
  exports: [AuditService],
})
export class AuditModule {}
