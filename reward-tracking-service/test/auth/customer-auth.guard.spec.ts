/**
 * T-RTS-032 — `CustomerAuthGuard` and its token codec.
 *
 * No decorator/`Reflector` involvement here (unlike the portal-admin guard) — every route this
 * guard protects is customer-scoped by construction (implementation note 2), so the only routing
 * concern is the `:customerId` path-parameter cross-check `canActivate` performs directly.
 */
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import {
  CustomerAuthGuard,
  type CustomerAuthContext,
  type CustomerTokenClaims,
  InvalidCustomerTokenError,
  loadCustomerAuthSecret,
  type RequestWithCustomerAuth,
  signCustomerToken,
  verifyCustomerToken,
} from '@/modules/auth/customer-auth.guard';
import {
  type PortalAdminTokenClaims,
  signPortalAdminToken,
} from '@/modules/auth/portal-admin-auth.guard';

function contextFrom(request: Partial<RequestWithCustomerAuth>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => request as T,
    }),
  } as unknown as ExecutionContext;
}

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

const SECRET = Buffer.alloc(32, 3);
const OTHER_SECRET = Buffer.alloc(32, 4);
const ENV_KEY = 'CUSTOMER_API_AUTH_SECRET';

function claims(overrides: Partial<CustomerTokenClaims> = {}): CustomerTokenClaims {
  return {
    tenantId: 42,
    customerId: 'MSISDN-60123456789',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

describe('T-RTS-032 — customer-auth.guard', () => {
  describe('loadCustomerAuthSecret', () => {
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
      expect(() => loadCustomerAuthSecret()).toThrow(new RegExp(`${ENV_KEY} is required`));
    });

    it('throws when the decoded secret is shorter than 32 bytes', () => {
      process.env[ENV_KEY] = Buffer.alloc(8, 1).toString('base64');
      expect(() => loadCustomerAuthSecret()).toThrow(/at least 32 bytes/);
    });

    it('returns the decoded secret when valid', () => {
      process.env[ENV_KEY] = SECRET.toString('base64');
      expect(loadCustomerAuthSecret()).toEqual(SECRET);
    });
  });

  describe('sign/verify round trip', () => {
    it('verifies a token signed with the same secret and returns the original claims', () => {
      const token = signCustomerToken(claims(), SECRET);
      expect(verifyCustomerToken(token, SECRET)).toEqual(claims());
    });

    it('rejects a token whose payload was tampered with (signature no longer matches)', () => {
      const token = signCustomerToken(claims(), SECRET);
      const [, signature] = token.split('.');
      const tamperedPayload = Buffer.from(
        JSON.stringify(claims({ customerId: 'MSISDN-ATTACKER' })),
      ).toString('base64url');
      const tampered = `${tamperedPayload}.${signature}`;
      expect(() => verifyCustomerToken(tampered, SECRET)).toThrow(InvalidCustomerTokenError);
    });

    it('rejects a token signed with a different secret', () => {
      const token = signCustomerToken(claims(), OTHER_SECRET);
      expect(() => verifyCustomerToken(token, SECRET)).toThrow(InvalidCustomerTokenError);
    });

    it('rejects an expired token', () => {
      const token = signCustomerToken(claims({ exp: Math.floor(Date.now() / 1000) - 1 }), SECRET);
      expect(() => verifyCustomerToken(token, SECRET)).toThrow(/expired/i);
    });

    it('rejects a malformed token (wrong number of segments)', () => {
      expect(() => verifyCustomerToken('not-a-token', SECRET)).toThrow(InvalidCustomerTokenError);
      expect(() => verifyCustomerToken('a.b.c', SECRET)).toThrow(InvalidCustomerTokenError);
    });

    it('rejects a well-signed token whose payload decodes to something other than valid claims', () => {
      const payloadSegment = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64url');
      const signature = createHmac('sha256', SECRET).update(payloadSegment).digest('base64url');
      expect(() => verifyCustomerToken(`${payloadSegment}.${signature}`, SECRET)).toThrow(
        InvalidCustomerTokenError,
      );
    });

    it('rejects a well-signed token with an empty customerId', () => {
      const payloadSegment = Buffer.from(JSON.stringify({ ...claims(), customerId: '' })).toString(
        'base64url',
      );
      const signature = createHmac('sha256', SECRET).update(payloadSegment).digest('base64url');
      expect(() => verifyCustomerToken(`${payloadSegment}.${signature}`, SECRET)).toThrow(
        InvalidCustomerTokenError,
      );
    });
  });

  describe('CustomerAuthGuard', () => {
    let guard: CustomerAuthGuard;
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env[ENV_KEY];
      process.env[ENV_KEY] = SECRET.toString('base64');
      guard = new CustomerAuthGuard();
    });

    afterEach(() => {
      if (saved === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = saved;
    });

    it('TC-4: a valid customer identity extracts customerId and lets the request proceed', () => {
      const token = signCustomerToken(claims(), SECRET);
      const request = {
        headers: authHeader(token),
        params: { customerId: 'MSISDN-60123456789' },
      } as unknown as RequestWithCustomerAuth;

      expect(guard.canActivate(contextFrom(request))).toBe(true);
      expect(request.customerAuth).toEqual<CustomerAuthContext>({
        tenantId: 42,
        customerId: 'MSISDN-60123456789',
      });
    });

    it('accepts a request with no :customerId path parameter at all (e.g. a list-all route)', () => {
      const token = signCustomerToken(claims(), SECRET);
      const request = {
        headers: authHeader(token),
        params: {},
      } as unknown as RequestWithCustomerAuth;
      expect(guard.canActivate(contextFrom(request))).toBe(true);
    });

    it('rejects a cross-customer access attempt with 403, not 401', () => {
      const token = signCustomerToken(claims({ customerId: 'MSISDN-60123456789' }), SECRET);
      const request = {
        headers: authHeader(token),
        params: { customerId: 'MSISDN-99999999999' },
      } as unknown as RequestWithCustomerAuth;
      expect(() => guard.canActivate(contextFrom(request))).toThrow(ForbiddenException);
    });

    it('rejects a missing token with 401', () => {
      const request = { headers: {}, params: {} } as unknown as RequestWithCustomerAuth;
      expect(() => guard.canActivate(contextFrom(request))).toThrow(UnauthorizedException);
    });

    it('rejects a malformed token with 401', () => {
      const request = {
        headers: authHeader('garbage'),
        params: {},
      } as unknown as RequestWithCustomerAuth;
      expect(() => guard.canActivate(contextFrom(request))).toThrow(UnauthorizedException);
    });

    it('rejects an expired token with 401', () => {
      const token = signCustomerToken(claims({ exp: Math.floor(Date.now() / 1000) - 10 }), SECRET);
      const request = {
        headers: authHeader(token),
        params: {},
      } as unknown as RequestWithCustomerAuth;
      expect(() => guard.canActivate(contextFrom(request))).toThrow(UnauthorizedException);
    });

    it('TC-5 (reverse direction): a portal-admin-shaped credential is rejected against a customer endpoint', () => {
      // Signed under the *portal admin* secret/shape, never the customer secret this guard is
      // configured with — the signature fails before the (entirely different) claim shape is
      // ever inspected, which is the property this test asserts.
      const adminShapedToken = signPortalAdminToken(
        {
          role: 'tenant_admin',
          countryId: 3,
          tenantId: 42,
          merchantId: null,
          exp: claims().exp,
        } as PortalAdminTokenClaims,
        OTHER_SECRET,
      );
      const request = {
        headers: authHeader(adminShapedToken),
        params: { customerId: 'MSISDN-60123456789' },
      } as unknown as RequestWithCustomerAuth;
      expect(() => guard.canActivate(contextFrom(request))).toThrow(UnauthorizedException);
    });
  });
});
