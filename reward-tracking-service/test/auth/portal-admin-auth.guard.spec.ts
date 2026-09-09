/**
 * T-RTS-032 — `PortalAdminAuthGuard`, its token codec, and `assertPortalAdminScope`.
 *
 * `contextFor` builds an `ExecutionContext` backed by a **real** decorated controller and a real
 * `Reflector`, the same choice `portal/back-end/test/rbac/support/execution-context.ts` documents
 * for `RolesGuard`'s own tests: stubbing `Reflector.getAllAndOverride` to return a canned array
 * would test the guard's `if` statements while assuming away whether `@RequirePortalRoles(...)`
 * actually writes the metadata key the guard reads, and whether handler-level metadata really
 * overrides class-level metadata — exactly the bugs a metadata bug actually is.
 */
import { Controller, ForbiddenException, Get, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext, Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHmac } from 'node:crypto';
import {
  assertPortalAdminScope,
  InvalidPortalAdminTokenError,
  loadPortalAdminAuthSecret,
  PortalAdminAuthGuard,
  type PortalAdminAuthContext,
  type PortalAdminTokenClaims,
  type RequestWithPortalAdmin,
  RequirePortalRoles,
  signPortalAdminToken,
  verifyPortalAdminToken,
} from '@/modules/auth/portal-admin-auth.guard';

// --- test-only ExecutionContext double, mirroring the portal's own `contextFor` -----------------

type ControllerClass = Type<object>;

function contextFor(
  controller: ControllerClass,
  handler: string,
  request: Partial<RequestWithPortalAdmin> = {},
): ExecutionContext {
  const method = (controller.prototype as Record<string, unknown>)[handler];
  if (typeof method !== 'function') {
    throw new Error(`${controller.name} has no handler named "${handler}"`);
  }
  return {
    getType: () => 'http',
    getClass: () => controller,
    getHandler: () => method,
    switchToHttp: () => ({
      getRequest: <T>() => request as T,
    }),
  } as unknown as ExecutionContext;
}

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

@Controller('reward-tracking')
class FakeAdminController {
  @Get('tenants/:tenantId/summary')
  @RequirePortalRoles('tenant_admin', 'super_admin')
  tenantSummary(): unknown {
    return {};
  }

  @Get('merchants/:merchantCode/summary')
  @RequirePortalRoles('merchant')
  merchantSummary(): unknown {
    return {};
  }

  @Get('alerts')
  @RequirePortalRoles('super_admin', 'country_admin', 'tenant_admin', 'maker', 'checker')
  alerts(): unknown {
    return {};
  }

  /** T-013's own TC-18 lesson applied here: no `@RequirePortalRoles(...)` at all. */
  @Get('oops')
  unguarded(): unknown {
    return {};
  }
}

@Controller('reward-tracking/class-scoped')
@RequirePortalRoles('super_admin')
class ClassLevelController {
  @Get()
  inherited(): unknown {
    return {};
  }

  @Get('widened')
  @RequirePortalRoles('tenant_admin')
  widened(): unknown {
    return {};
  }
}

const SECRET = Buffer.alloc(32, 7);
const OTHER_SECRET = Buffer.alloc(32, 9);
const ENV_KEY = 'PORTAL_ADMIN_API_AUTH_SECRET';

function claims(overrides: Partial<PortalAdminTokenClaims> = {}): PortalAdminTokenClaims {
  return {
    role: 'tenant_admin',
    countryId: 3,
    tenantId: 42,
    merchantId: null,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

describe('T-RTS-032 — portal-admin-auth.guard', () => {
  describe('loadPortalAdminAuthSecret', () => {
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env[ENV_KEY];
    });

    afterEach(() => {
      if (saved === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = saved;
    });

    it('throws when the env var is missing', () => {
      delete process.env[ENV_KEY];
      expect(() => loadPortalAdminAuthSecret()).toThrow(new RegExp(`${ENV_KEY} is required`));
    });

    it('throws when the decoded secret is shorter than 32 bytes', () => {
      process.env[ENV_KEY] = Buffer.alloc(10, 1).toString('base64');
      expect(() => loadPortalAdminAuthSecret()).toThrow(/at least 32 bytes/);
    });

    it('returns the decoded secret when valid', () => {
      process.env[ENV_KEY] = SECRET.toString('base64');
      expect(loadPortalAdminAuthSecret()).toEqual(SECRET);
    });
  });

  describe('sign/verify round trip', () => {
    it('verifies a token signed with the same secret and returns the original claims', () => {
      const token = signPortalAdminToken(claims(), SECRET);
      expect(verifyPortalAdminToken(token, SECRET)).toEqual(claims());
    });

    it('accepts every one of the six real portal roles', () => {
      for (const role of [
        'super_admin',
        'country_admin',
        'tenant_admin',
        'maker',
        'checker',
        'merchant',
      ] as const) {
        const token = signPortalAdminToken(claims({ role }), SECRET);
        expect(verifyPortalAdminToken(token, SECRET).role).toBe(role);
      }
    });

    it('accepts the super_admin scope triple — every scope field null', () => {
      const token = signPortalAdminToken(
        claims({ role: 'super_admin', countryId: null, tenantId: null, merchantId: null }),
        SECRET,
      );
      const verified = verifyPortalAdminToken(token, SECRET);
      expect(verified.countryId).toBeNull();
      expect(verified.tenantId).toBeNull();
      expect(verified.merchantId).toBeNull();
    });

    it('rejects a token whose payload was tampered with (signature no longer matches)', () => {
      const token = signPortalAdminToken(claims(), SECRET);
      const [, signature] = token.split('.');
      const tamperedPayload = Buffer.from(
        JSON.stringify(claims({ role: 'super_admin', tenantId: null })),
      ).toString('base64url');
      const tampered = `${tamperedPayload}.${signature}`;
      expect(tampered).not.toBe(token);
      expect(() => verifyPortalAdminToken(tampered, SECRET)).toThrow(InvalidPortalAdminTokenError);
    });

    it('rejects a token signed with a different secret', () => {
      const token = signPortalAdminToken(claims(), OTHER_SECRET);
      expect(() => verifyPortalAdminToken(token, SECRET)).toThrow(InvalidPortalAdminTokenError);
    });

    it('rejects an expired token', () => {
      const token = signPortalAdminToken(
        claims({ exp: Math.floor(Date.now() / 1000) - 1 }),
        SECRET,
      );
      expect(() => verifyPortalAdminToken(token, SECRET)).toThrow(/expired/i);
    });

    it('rejects a malformed token (wrong number of segments)', () => {
      expect(() => verifyPortalAdminToken('not-a-token', SECRET)).toThrow(
        InvalidPortalAdminTokenError,
      );
      expect(() => verifyPortalAdminToken('a.b.c', SECRET)).toThrow(InvalidPortalAdminTokenError);
    });

    it('rejects a well-signed token asserting a role outside the real six', () => {
      const payloadSegment = Buffer.from(
        JSON.stringify({ ...claims(), role: 'forged_role' }),
      ).toString('base64url');
      const signature = createHmac('sha256', SECRET).update(payloadSegment).digest('base64url');
      expect(() => verifyPortalAdminToken(`${payloadSegment}.${signature}`, SECRET)).toThrow(
        InvalidPortalAdminTokenError,
      );
    });

    it('rejects a well-signed token whose scope fields are not null-or-positive-integer', () => {
      const payloadSegment = Buffer.from(JSON.stringify({ ...claims(), tenantId: -1 })).toString(
        'base64url',
      );
      const signature = createHmac('sha256', SECRET).update(payloadSegment).digest('base64url');
      expect(() => verifyPortalAdminToken(`${payloadSegment}.${signature}`, SECRET)).toThrow(
        InvalidPortalAdminTokenError,
      );
    });
  });

  describe('PortalAdminAuthGuard', () => {
    let guard: PortalAdminAuthGuard;
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env[ENV_KEY];
      process.env[ENV_KEY] = SECRET.toString('base64');
      guard = new PortalAdminAuthGuard(new Reflector());
    });

    afterEach(() => {
      if (saved === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = saved;
    });

    it('TC-1: a valid Tenant Admin token extracts tenantId and lets the request proceed', () => {
      const token = signPortalAdminToken(
        claims({ role: 'tenant_admin', tenantId: 42, countryId: 3, merchantId: null }),
        SECRET,
      );
      const request = {
        headers: authHeader(token),
        params: { tenantId: '42' },
      } as unknown as RequestWithPortalAdmin;
      const context = contextFor(FakeAdminController, 'tenantSummary', request);

      expect(guard.canActivate(context)).toBe(true);
      expect(request.portalAdmin).toEqual<PortalAdminAuthContext>({
        role: 'tenant_admin',
        countryId: 3,
        tenantId: 42,
        merchantId: null,
      });
    });

    it('TC-2: a token for the wrong role calling a Merchant-only endpoint is rejected', () => {
      const token = signPortalAdminToken(claims({ role: 'tenant_admin' }), SECRET);
      const request = { headers: authHeader(token) } as unknown as RequestWithPortalAdmin;
      const context = contextFor(FakeAdminController, 'merchantSummary', request);

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('TC-3a: a missing token is rejected with 401', () => {
      const request = { headers: {} } as unknown as RequestWithPortalAdmin;
      const context = contextFor(FakeAdminController, 'alerts', request);
      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    });

    it('TC-3b: a malformed token is rejected with 401', () => {
      const request = {
        headers: authHeader('not-a-real-token'),
      } as unknown as RequestWithPortalAdmin;
      const context = contextFor(FakeAdminController, 'alerts', request);
      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    });

    it('TC-3c: an expired token is rejected with 401', () => {
      const token = signPortalAdminToken(
        claims({ role: 'maker', exp: Math.floor(Date.now() / 1000) - 5 }),
        SECRET,
      );
      const request = { headers: authHeader(token) } as unknown as RequestWithPortalAdmin;
      const context = contextFor(FakeAdminController, 'alerts', request);
      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    });

    it('TC-5: a customer-shaped credential (different secret entirely) is rejected against a portal-admin endpoint', () => {
      // Simulates the customer guard's own token shape presented here — signed under a secret
      // this guard was never configured with, exactly as the two guards' real, independently
      // configured secrets would differ in production.
      const customerShapedToken = signPortalAdminToken(
        // Cast through unknown: a customer token has no `role`/scope-triple at all, so this is
        // deliberately not a `PortalAdminTokenClaims` — the point is that the shape does not
        // matter, because the signature is checked first and fails regardless of shape.
        {
          tenantId: 42,
          customerId: 'MSISDN-60123456789',
          exp: claims().exp,
        } as unknown as PortalAdminTokenClaims,
        OTHER_SECRET,
      );
      const request = {
        headers: authHeader(customerShapedToken),
      } as unknown as RequestWithPortalAdmin;
      const context = contextFor(FakeAdminController, 'alerts', request);
      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    });

    it('fails closed: a route with no @RequirePortalRoles(...) at all is denied even with a fully valid token', () => {
      const token = signPortalAdminToken(
        claims({ role: 'super_admin', tenantId: null, countryId: null }),
        SECRET,
      );
      const request = { headers: authHeader(token) } as unknown as RequestWithPortalAdmin;
      const context = contextFor(FakeAdminController, 'unguarded', request);
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('admits any role named in a multi-role list', () => {
      for (const role of [
        'super_admin',
        'country_admin',
        'tenant_admin',
        'maker',
        'checker',
      ] as const) {
        const token = signPortalAdminToken(claims({ role }), SECRET);
        const request = { headers: authHeader(token) } as unknown as RequestWithPortalAdmin;
        const context = contextFor(FakeAdminController, 'alerts', request);
        expect(guard.canActivate(context)).toBe(true);
      }
    });

    it('denies a role absent from the route allow-list', () => {
      const token = signPortalAdminToken(claims({ role: 'merchant', merchantId: 9 }), SECRET);
      const request = { headers: authHeader(token) } as unknown as RequestWithPortalAdmin;
      const context = contextFor(FakeAdminController, 'alerts', request);
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    describe('class-level metadata', () => {
      it('applies to a handler that declares none of its own', () => {
        const superAdminToken = signPortalAdminToken(
          claims({ role: 'super_admin', tenantId: null, countryId: null }),
          SECRET,
        );
        const allowed = contextFor(ClassLevelController, 'inherited', {
          headers: authHeader(superAdminToken),
        } as unknown as RequestWithPortalAdmin);
        expect(guard.canActivate(allowed)).toBe(true);

        const makerToken = signPortalAdminToken(claims({ role: 'maker' }), SECRET);
        const denied = contextFor(ClassLevelController, 'inherited', {
          headers: authHeader(makerToken),
        } as unknown as RequestWithPortalAdmin);
        expect(() => guard.canActivate(denied)).toThrow(ForbiddenException);
      });

      it('is overridden — not merged — by handler-level metadata', () => {
        const tenantAdminToken = signPortalAdminToken(claims({ role: 'tenant_admin' }), SECRET);
        const tenantAdminContext = contextFor(ClassLevelController, 'widened', {
          headers: authHeader(tenantAdminToken),
        } as unknown as RequestWithPortalAdmin);
        expect(guard.canActivate(tenantAdminContext)).toBe(true);

        // If the two lists merged, super_admin (the class-level role) would still be admitted
        // here. It must not be — `getAllAndOverride` semantics are what this guard relies on.
        const superAdminToken = signPortalAdminToken(
          claims({ role: 'super_admin', tenantId: null, countryId: null }),
          SECRET,
        );
        const superAdminContext = contextFor(ClassLevelController, 'widened', {
          headers: authHeader(superAdminToken),
        } as unknown as RequestWithPortalAdmin);
        expect(() => guard.canActivate(superAdminContext)).toThrow(ForbiddenException);
      });
    });
  });

  describe('assertPortalAdminScope', () => {
    it('passes when every required dimension matches the claim exactly', () => {
      const context: PortalAdminAuthContext = {
        role: 'merchant',
        countryId: 3,
        tenantId: 42,
        merchantId: 9,
      };
      expect(() =>
        assertPortalAdminScope(context, { tenantId: 42, merchantId: 9, countryId: 3 }),
      ).not.toThrow();
    });

    it('rejects a mismatched tenantId', () => {
      const context: PortalAdminAuthContext = {
        role: 'tenant_admin',
        countryId: 3,
        tenantId: 42,
        merchantId: null,
      };
      expect(() => assertPortalAdminScope(context, { tenantId: 99 })).toThrow(ForbiddenException);
    });

    it('rejects a mismatched merchantId', () => {
      const context: PortalAdminAuthContext = {
        role: 'merchant',
        countryId: 3,
        tenantId: 42,
        merchantId: 9,
      };
      expect(() => assertPortalAdminScope(context, { merchantId: 1 })).toThrow(ForbiddenException);
    });

    it('rejects a mismatched countryId', () => {
      const context: PortalAdminAuthContext = {
        role: 'country_admin',
        countryId: 3,
        tenantId: null,
        merchantId: null,
      };
      expect(() => assertPortalAdminScope(context, { countryId: 4 })).toThrow(ForbiddenException);
    });

    it('a null scope field on the claim means "every value" — never rejected', () => {
      const superAdmin: PortalAdminAuthContext = {
        role: 'super_admin',
        countryId: null,
        tenantId: null,
        merchantId: null,
      };
      expect(() =>
        assertPortalAdminScope(superAdmin, { tenantId: 1, merchantId: 2, countryId: 3 }),
      ).not.toThrow();

      const countryAdmin: PortalAdminAuthContext = {
        role: 'country_admin',
        countryId: 3,
        tenantId: null,
        merchantId: null,
      };
      expect(() => assertPortalAdminScope(countryAdmin, { tenantId: 1 })).not.toThrow();
    });
  });
});
