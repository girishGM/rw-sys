/**
 * T-013 — `RolesGuard`: TC-1, TC-2, TC-3 and TC-18.
 *
 * The controllers below are real, decorated classes and the `Reflector` is a real one, so the
 * metadata path under test is the production path (see `support/execution-context.ts`).
 */
import { Controller, Delete, Get, Post } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Public } from '@/modules/auth/decorators/public.decorator';
import {
  PermissionDeniedHttpException,
  RequirePermission,
  Roles,
  RolesGuard,
  routeLabel,
} from '@/common/rbac';
import { actor, contextFor } from './support/execution-context';

@Controller('rules')
class RulesController {
  @Post()
  @Roles('super_admin')
  create(): unknown {
    return {};
  }

  @Get()
  @Roles('super_admin', 'country_admin', 'maker', 'checker', 'tenant_admin')
  list(): unknown {
    return {};
  }

  /** Guarded by layer 2 only — no `@Roles`. */
  @Delete()
  @RequirePermission('rule', 'delete')
  remove(): unknown {
    return {};
  }

  /** TC-18: the mistake this guard exists to catch. */
  @Get('oops')
  unguarded(): unknown {
    return {};
  }

  @Get('health')
  @Public()
  publicRoute(): unknown {
    return {};
  }
}

@Controller('admin')
@Roles('super_admin')
class ClassLevelController {
  @Get()
  inherited(): unknown {
    return {};
  }

  /** Handler metadata must override the class's, not merge with it. */
  @Get('shared')
  @Roles('tenant_admin')
  widened(): unknown {
    return {};
  }
}

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let errors: jest.SpyInstance;
  let debugs: jest.SpyInstance;

  beforeEach(() => {
    guard = new RolesGuard(new Reflector());
    // The log messages are part of the contract for TC-18 — asserted, not merely silenced.
    errors = jest
      .spyOn((guard as unknown as { logger: { error: () => void } }).logger, 'error')
      .mockImplementation(() => undefined);
    debugs = jest
      .spyOn((guard as unknown as { logger: { debug: () => void } }).logger, 'debug')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('TC-1: admits a super_admin to a @Roles("super_admin") route', () => {
    const context = contextFor(RulesController, 'create', {
      authUser: actor({ role: 'super_admin', tenantId: null, countryId: null }),
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('TC-2: denies a maker on the same route with PERM_DENIED', () => {
    const context = contextFor(RulesController, 'create', { authUser: actor({ role: 'maker' }) });

    expect(() => guard.canActivate(context)).toThrow(PermissionDeniedHttpException);
  });

  it('TC-3: the 403 body names no resource, no id and no reason', () => {
    const context = contextFor(RulesController, 'create', { authUser: actor({ role: 'maker' }) });

    let thrown: PermissionDeniedHttpException | undefined;
    try {
      guard.canActivate(context);
    } catch (error) {
      thrown = error as PermissionDeniedHttpException;
    }

    expect(thrown?.getStatus()).toBe(403);
    expect(thrown?.getResponse()).toEqual({ error: { code: 'PERM_DENIED' } });

    const body = JSON.stringify(thrown?.getResponse());
    for (const leak of ['rule', 'Rule', 'super_admin', 'maker', 'create', 'RulesController']) {
      expect(body).not.toContain(leak);
    }
  });

  it('does not reveal the allowed roles to the caller, only to the log', () => {
    const context = contextFor(RulesController, 'create', { authUser: actor({ role: 'maker' }) });
    expect(() => guard.canActivate(context)).toThrow();

    expect(debugs).toHaveBeenCalledWith(expect.stringContaining('super_admin'));
  });

  it('admits any role named in a multi-role list', () => {
    for (const role of [
      'super_admin',
      'country_admin',
      'maker',
      'checker',
      'tenant_admin',
    ] as const) {
      const context = contextFor(RulesController, 'list', { authUser: actor({ role }) });
      expect(guard.canActivate(context)).toBe(true);
    }
  });

  it('denies a role absent from the list', () => {
    const context = contextFor(RulesController, 'list', { authUser: actor({ role: 'merchant' }) });
    expect(() => guard.canActivate(context)).toThrow(PermissionDeniedHttpException);
  });

  it('passes a route guarded by @RequirePermission alone through to layer 2', () => {
    const context = contextFor(RulesController, 'remove', { authUser: actor({ role: 'maker' }) });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('TC-18: denies a route with neither @Roles nor @Public, and logs it as an error', () => {
    const context = contextFor(RulesController, 'unguarded', { authUser: actor() });

    expect(() => guard.canActivate(context)).toThrow(PermissionDeniedHttpException);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('declares neither @Roles() nor @RequirePermission()'),
    );
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('RulesController.unguarded'));
  });

  it('TC-18: denies an unguarded route even when nobody is authenticated', () => {
    const context = contextFor(RulesController, 'unguarded');
    expect(() => guard.canActivate(context)).toThrow(PermissionDeniedHttpException);
  });

  it('admits a @Public() route without looking at anything else', () => {
    const context = contextFor(RulesController, 'publicRoute');
    expect(guard.canActivate(context)).toBe(true);
    expect(errors).not.toHaveBeenCalled();
  });

  it('denies, loudly, when the chain is mis-ordered and there is no authUser', () => {
    const context = contextFor(RulesController, 'create');

    expect(() => guard.canActivate(context)).toThrow(PermissionDeniedHttpException);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('no authenticated user'));
  });

  it('passes a non-HTTP context through — the gRPC port carries its own guards', () => {
    const context = contextFor(RulesController, 'create', { type: 'rpc' });
    expect(guard.canActivate(context)).toBe(true);
  });

  describe('class-level metadata', () => {
    it('applies to a handler that declares none of its own', () => {
      const allowed = contextFor(ClassLevelController, 'inherited', {
        authUser: actor({ role: 'super_admin' }),
      });
      const denied = contextFor(ClassLevelController, 'inherited', {
        authUser: actor({ role: 'maker' }),
      });

      expect(guard.canActivate(allowed)).toBe(true);
      expect(() => guard.canActivate(denied)).toThrow(PermissionDeniedHttpException);
    });

    it('is overridden — not merged — by handler-level metadata', () => {
      const tenantAdmin = contextFor(ClassLevelController, 'widened', {
        authUser: actor({ role: 'tenant_admin' }),
      });
      const superAdmin = contextFor(ClassLevelController, 'widened', {
        authUser: actor({ role: 'super_admin' }),
      });

      expect(guard.canActivate(tenantAdmin)).toBe(true);
      // If the two lists merged, `super_admin` would still be admitted here. It must not be:
      // `getAllAndOverride` semantics are what every other guard in the chain relies on too.
      expect(() => guard.canActivate(superAdmin)).toThrow(PermissionDeniedHttpException);
    });
  });

  describe('routeLabel', () => {
    it('renders Controller.handler for the log', () => {
      const context = contextFor(RulesController, 'create', { authUser: actor() });
      expect(routeLabel(context)).toBe('RulesController.create');
    });
  });
});
