/**
 * T-013 — `RbacModule` and `ScopeModule`: the DI wiring, and the guard order 00-ARCHITECTURE.md
 * §6 fixes.
 *
 * The order assertion is the reason this file exists. §6 says *"Order matters and is enforced by
 * a single `AppModule` composition; agents must not reorder it"*, and a reordering is exactly the
 * kind of change that produces no test failure anywhere else: the application still boots, every
 * endpoint still works, and the only symptom is that (say) a permission lookup now runs before
 * the session has been checked, so a revoked session consumes a database read and an authorisation
 * decision it should never have reached.
 *
 * `Reflect.getMetadata('providers', …)` reads the *declared* array, which is what Nest walks —
 * so this asserts the order that actually ships, not a copy of it.
 */
jest.mock('@/database/database.module', () =>
  jest.requireActual('../auth/support/fake-database.module'),
);
jest.mock('@/config/config.module', () =>
  jest.requireActual('../security/support/fake-config.module'),
);

import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { PasswordChangeRequiredGuard } from '@/modules/auth/guards/password-change-required.guard';
import { SessionValidGuard } from '@/modules/auth/guards/session-valid.guard';
// T-055 — positions 4b and 6c of the chain asserted below.
import {
  MfaPendingConfinementGuard,
  MfaRequiredGuard,
} from '@/modules/auth/guards/mfa-required.guard';
import { RbacModule } from '@/common/rbac/rbac.module';
import { PermissionCacheService } from '@/common/rbac/permission-cache.service';
import {
  PermissionRepository,
  PERMISSION_STORE,
  type PermissionStore,
} from '@/common/rbac/permission.repository';
import { PermissionsGuard } from '@/common/rbac/permissions.guard';
import { RolesGuard } from '@/common/rbac/roles.guard';
import { ScopeModule } from '@/common/scope/scope.module';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { TenancyScopeInterceptor } from '@/common/scope/tenancy-scope.interceptor';
import { fakeSecurityConfigService } from '../security/support/fake-config.module';

interface ProviderEntry {
  provide?: unknown;
  useExisting?: unknown;
  useClass?: unknown;
}

function providersOf(module: unknown): ProviderEntry[] {
  return (Reflect.getMetadata('providers', module as object) ?? []) as ProviderEntry[];
}

describe('RbacModule', () => {
  async function compile() {
    return Test.createTestingModule({ imports: [RbacModule] })
      .overrideProvider(ConfigService)
      .useValue(fakeSecurityConfigService())
      .compile();
  }

  it('resolves the permission layer', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(PermissionCacheService)).toBeInstanceOf(PermissionCacheService);
    expect(moduleRef.get<PermissionStore>(PERMISSION_STORE)).toBeInstanceOf(PermissionRepository);
    expect(moduleRef.get(RolesGuard)).toBeInstanceOf(RolesGuard);
    expect(moduleRef.get(PermissionsGuard)).toBeInstanceOf(PermissionsGuard);
  });

  it('re-exports ScopeModule, so one import gets a feature module everything it needs', async () => {
    const moduleRef = await compile();
    expect(moduleRef.get(ScopedRepository, { strict: false })).toBeInstanceOf(ScopedRepository);
  });

  it('binds PERMISSION_STORE to the raw-SQL repository, and nowhere else', () => {
    const bindings = providersOf(RbacModule).filter((p) => p.provide === PERMISSION_STORE);

    expect(bindings).toHaveLength(1);
    expect(bindings[0].useClass).toBe(PermissionRepository);
  });

  describe('the §6 guard chain', () => {
    it('registers positions 4b → 8 in order, and nothing else', () => {
      const globalGuards = providersOf(RbacModule)
        .filter((provider) => provider.provide === APP_GUARD)
        .map((provider) => provider.useExisting);

      // T-055 inserted 4b and 6c. Their **positions** are the assertion, not their presence:
      // `MfaPendingConfinementGuard` has to precede `JwtAuthGuard` (it answers for a caller who
      // has no session to authenticate, and would otherwise never be reached), and
      // `MfaRequiredGuard` has to follow `SessionValidGuard` (it reads `request.authUser`) while
      // preceding the authorisation layers (a confined session should not consume a permission
      // lookup). Reordering this array is a security change; this test is what makes that
      // explicit rather than accidental.
      expect(globalGuards).toEqual([
        MfaPendingConfinementGuard, //   4b is this caller halfway through an MFA challenge?
        JwtAuthGuard, //                 5  is there a valid access token?
        SessionValidGuard, //            6  is the session (and its parents) still alive?
        PasswordChangeRequiredGuard, //  6b is this session confined to the change-password flow?
        MfaRequiredGuard, //             6c is this super_admin's session backed by a second factor?
        RolesGuard, //                   7  may this role approach this route?
        PermissionsGuard, //             8  has Super Admin granted this action?
      ]);
    });

    it('uses useExisting throughout, so the global entry is the exported instance', () => {
      // `useClass` would give a *second* instance of each guard. For `PermissionsGuard` that
      // means a second `PermissionCacheService` with its own cache — so `bumpVersion()` called on
      // the injected one would leave the one actually guarding requests serving stale grants.
      const entries = providersOf(RbacModule).filter((provider) => provider.provide === APP_GUARD);

      for (const entry of entries) {
        expect(entry.useExisting).toBeDefined();
        expect(entry.useClass).toBeUndefined();
      }
    });

    it('registers no global interceptor of its own — that is ScopeModule’s job', () => {
      const interceptors = providersOf(RbacModule).filter(
        (provider) => provider.provide === APP_INTERCEPTOR,
      );
      expect(interceptors).toEqual([]);
    });
  });
});

describe('ScopeModule', () => {
  async function compile() {
    return Test.createTestingModule({ imports: [ScopeModule] }).compile();
  }

  it('resolves the repository and the interceptor', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(ScopedRepository)).toBeInstanceOf(ScopedRepository);
    expect(moduleRef.get(TenancyScopeInterceptor)).toBeInstanceOf(TenancyScopeInterceptor);
  });

  it('registers the interceptor globally, with useExisting', () => {
    const entries = providersOf(ScopeModule).filter(
      (provider) => provider.provide === APP_INTERCEPTOR,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].useExisting).toBe(TenancyScopeInterceptor);
    expect(entries[0].useClass).toBeUndefined();
  });

  it('exports ScopedRepository — a feature module cannot inject what is not exported', () => {
    const exported = (Reflect.getMetadata('exports', ScopeModule) ?? []) as unknown[];
    expect(exported).toContain(ScopedRepository);
  });
});

describe('AppModule composition', () => {
  it('imports RbacModule after SecurityModule, so §6’s order survives', async () => {
    // Across modules, Nest registers global providers in module-resolution order. If RbacModule
    // were imported first, authentication would run before rate limiting and CSRF — the exact
    // reordering §6 forbids. Asserted on the metadata rather than by booting, because booting
    // AppModule needs the real database.
    const { AppModule } = await import('@/app.module');
    const imports = (Reflect.getMetadata('imports', AppModule) ?? []) as Array<{ name: string }>;
    const names = imports.map((module) => module.name);

    expect(names).toContain('SecurityModule');
    expect(names).toContain('RbacModule');
    expect(names.indexOf('RbacModule')).toBeGreaterThan(names.indexOf('SecurityModule'));
  });
});
