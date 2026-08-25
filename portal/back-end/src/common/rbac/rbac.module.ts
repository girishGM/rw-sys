/**
 * T-013 — **the composition of the global security chain**, in the fixed order
 * 00-ARCHITECTURE.md §6 specifies.
 *
 * ```
 *  1  HelmetMiddleware            main.ts            (T-012)
 *  2  CorsMiddleware              main.ts            (T-012)
 *  3  RateLimitGuard              SecurityModule     (T-012)
 *  4  CsrfGuard                   SecurityModule     (T-012)
 *  4b MfaPendingConfinementGuard  ← this file        (T-055, see below)
 *  5  JwtAuthGuard                ← this file
 *  6  SessionValidGuard           ← this file
 *  6b PasswordChangeRequiredGuard ← this file        (see below)
 *  6c MfaRequiredGuard            ← this file        (T-055, see below)
 *  7  RolesGuard                  ← this file
 *  8  PermissionsGuard            ← this file
 *  9  TenancyScopeInterceptor     ScopeModule        (imported and re-exported here)
 * ```
 *
 * §6 says *"Order matters and is enforced by a single `AppModule` composition; agents must not
 * reorder it."* Two mechanisms make the order above real rather than aspirational:
 *
 *  - **Within a module**, Nest invokes `APP_GUARD` providers in declaration order. The array
 *    below is therefore the order, and is written to be read top-to-bottom against §6.
 *  - **Across modules**, providers register in module-resolution order, which follows
 *    `AppModule`'s `imports` array. `SecurityModule` (3, 4) is imported before `RbacModule`
 *    (5–8), so the composed chain is §6's. Appending this module *after* `SecurityModule` in
 *    `app.module.ts` is not cosmetic — moving it before would run authentication before rate
 *    limiting and CSRF, which is the wrong order for exactly the reason §6 fixes one.
 *
 * ### 6b — `PasswordChangeRequiredGuard`
 *
 * §6's list predates it; T-011 built it from 02-SECURITY.md §2 ("restricted to auth and
 * MFA-enrolment endpoints only, **enforced by a guard, not front-end routing**", also
 * 00-ARCHITECTURE.md §5.2a) and applied it to `AuthController` with `@UseGuards`. Registering it
 * globally here is what extends that confinement to *every* endpoint — which is the only way it
 * means anything, since the point is to stop a provisioned account calling `POST /campaigns`
 * with a temporary password. It sits after session validation because it reads
 * `mustChangePassword`, which `SessionValidGuard` refreshes from the database, and before the
 * authorisation layers because a confined session should not consume a permission lookup.
 *
 * ### 4b and 6c — T-055's two MFA guards
 *
 * 02-SECURITY.md §11's release checklist requires that *"a fresh `super_admin` account cannot
 * reach any route beyond `/auth/*` and `/auth/mfa/enrol`"* until it has enrolled. That is a
 * statement about **every** endpoint, so — exactly like 6b — it can only be true if the guards
 * are global. `MfaRequiredGuard` (6c) reads `request.authUser`, so it must follow authentication;
 * `MfaPendingConfinementGuard` (4b) answers for a caller who has *no* session and would otherwise
 * be 401'd by `JwtAuthGuard` before anything could recognise their state, so it must precede it.
 * Both are deny-only and neither writes `request.authUser` — see `mfa-required.guard.ts`.
 *
 * ### AuthController keeps its `@UseGuards`, and that is deliberate
 *
 * Guards 5, 6 and 6b now run twice on `/auth/*`: once globally, once from the controller. The
 * duplication costs one extra `portal_sessions` lookup on a handful of low-traffic endpoints,
 * and it buys the property that T-013's own Rollback procedure — *"remove the guards from the
 * global provider list"* — leaves `/auth/*` guarded rather than wide open. A rollback that
 * silently unauthenticates the authentication module would be a worse outcome than a duplicated
 * query.
 *
 * This file is an addition to T-013's declared *Files owned* list; recorded as a deviation in
 * the completion report.
 */
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from '@/database/database.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { PasswordChangeRequiredGuard } from '@/modules/auth/guards/password-change-required.guard';
import { SessionValidGuard } from '@/modules/auth/guards/session-valid.guard';
// T-055 — positions 4b and 6c of the chain below.
import {
  MfaPendingConfinementGuard,
  MfaRequiredGuard,
} from '@/modules/auth/guards/mfa-required.guard';
import { ScopeModule } from '@/common/scope/scope.module';
import { PermissionCacheService } from './permission-cache.service';
import { PermissionRepository, PERMISSION_STORE } from './permission.repository';
import { PermissionsGuard } from './permissions.guard';
import { RolesGuard } from './roles.guard';

@Module({
  // `AuthModule` for guards 5/6/6b and `DatabaseModule` for `PermissionRepository`'s connection.
  // `ScopeModule` is imported *and re-exported*, so a Wave 3 feature module gets both
  // `ScopedRepository` and the RBAC services from a single `imports: [RbacModule]`.
  imports: [AuthModule, DatabaseModule, ScopeModule],
  providers: [
    { provide: PERMISSION_STORE, useClass: PermissionRepository },
    PermissionCacheService,
    RolesGuard,
    PermissionsGuard,

    // --- 00-ARCHITECTURE.md §6, positions 5 → 8. Do not reorder. --------------------------
    //
    // T-055 inserted 4b and 6c (see `mfa-required.guard.ts` for why the feature needs a guard on
    // each side of authentication). Neither displaces an existing line: 4b is *before* the whole
    // §6 block because it answers for a caller who has no session to authenticate, and 6c sits
    // where `PasswordChangeRequiredGuard` sits relative to the authorisation layers, and for the
    // same reason — a confined session should not consume a permission lookup.
    { provide: APP_GUARD, useExisting: MfaPendingConfinementGuard },
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_GUARD, useExisting: SessionValidGuard },
    { provide: APP_GUARD, useExisting: PasswordChangeRequiredGuard },
    { provide: APP_GUARD, useExisting: MfaRequiredGuard },
    { provide: APP_GUARD, useExisting: RolesGuard },
    { provide: APP_GUARD, useExisting: PermissionsGuard },
  ],
  exports: [PermissionCacheService, PERMISSION_STORE, RolesGuard, PermissionsGuard, ScopeModule],
})
export class RbacModule {}
