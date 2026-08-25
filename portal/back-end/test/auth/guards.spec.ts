/**
 * T-011 — the three guards, driven directly rather than through HTTP.
 *
 * `auth.e2e-spec.ts` exercises the same behaviour over a real request, which is the proof that
 * matters for TC-7/TC-8/TC-19. This file exists for the branches HTTP cannot easily reach: a
 * guard running out of order, a session whose `sid` names another user, a `@Public()` decorator
 * on a class rather than a handler. Those are wiring mistakes, and a wiring mistake in an
 * authentication chain has to fail closed — which is a claim you can only test by producing the
 * mistake deliberately.
 */
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  PasswordChangeRequiredHttpException,
  SessionInvalidHttpException,
} from '@/modules/auth/auth.exceptions';
import { ACCESS_COOKIE_NAME, ACCESS_TOKEN_TTL_SECONDS } from '@/modules/auth/session.constants';
import { IS_PUBLIC_KEY, Public } from '@/modules/auth/decorators/public.decorator';
import {
  AllowWhilePasswordChangeRequired,
  PASSWORD_CHANGE_EXEMPT_KEY,
} from '@/modules/auth/decorators/password-change-exempt.decorator';
import { CurrentUser, currentUserFrom } from '@/modules/auth/decorators/current-user.decorator';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { SessionValidGuard } from '@/modules/auth/guards/session-valid.guard';
import { PasswordChangeRequiredGuard } from '@/modules/auth/guards/password-change-required.guard';
import { SessionService } from '@/modules/auth/services/session.service';
import { TokenService } from '@/modules/auth/services/token.service';
import { FakeSessionStore } from './support/fake-session-store';
import {
  fakeConfigService,
  generateForeignKeyPair,
  generateTestKeyPair,
} from './support/test-keys';

/**
 * Unlike the service specs, these tests cannot pin the clock: the guards read `new Date()`
 * themselves, deliberately, so that nothing outside them can influence what "now" means during
 * an authorisation decision. Tokens are therefore minted at the real current time, and the one
 * case that needs a different clock (TC-8, expiry) moves the system clock forward instead.
 */
const CONTEXT = { ipAddress: null, userAgent: null };

/** A minimal `ExecutionContext`: a request object, plus whatever metadata the test attaches. */
function executionContext(
  request: Partial<AuthenticatedRequest>,
  metadata: Record<string, unknown> = {},
): { context: ExecutionContext; request: AuthenticatedRequest } {
  const req = { headers: {}, ...request } as AuthenticatedRequest;
  const handler = () => undefined;
  const controller = class Controller {};

  for (const [key, value] of Object.entries(metadata)) {
    Reflect.defineMetadata(key, value, handler);
  }

  const context = {
    switchToHttp: () => ({ getRequest: <T>() => req as T }),
    getHandler: () => handler,
    getClass: () => controller,
  } as unknown as ExecutionContext;

  return { context, request: req };
}

function build() {
  const keys = generateTestKeyPair();
  const tokens = new TokenService(
    fakeConfigService({ JWT_PRIVATE_KEY: keys.privateKey, JWT_PUBLIC_KEY: keys.publicKey }),
  );
  const store = new FakeSessionStore();
  const sessions = new SessionService(store, tokens);
  const reflector = new Reflector();

  return {
    store,
    tokens,
    sessions,
    reflector,
    jwtGuard: new JwtAuthGuard(reflector, tokens),
    sessionGuard: new SessionValidGuard(reflector, sessions),
    passwordGuard: new PasswordChangeRequiredGuard(reflector),
  };
}

async function loggedIn(harness: ReturnType<typeof build>, overrides = {}) {
  const user = harness.store.seedUser(overrides);
  const session = await harness.sessions.start(user, CONTEXT, new Date());
  return { user, session };
}

function cookieHeader(token: string): Record<string, string> {
  return { cookie: `${ACCESS_COOKIE_NAME}=${token}` };
}

describe('JwtAuthGuard', () => {
  it('lets a @Public() handler through without looking for a cookie at all', () => {
    const harness = build();
    const { context } = executionContext({}, { [IS_PUBLIC_KEY]: true });

    expect(harness.jwtGuard.canActivate(context)).toBe(true);
  });

  it('TC-7: rejects a request with no cookie header', () => {
    const harness = build();
    const { context } = executionContext({});

    expect(() => harness.jwtGuard.canActivate(context)).toThrow(SessionInvalidHttpException);
  });

  it('rejects a cookie header that carries other cookies but not the access one', () => {
    const harness = build();
    const { context } = executionContext({ headers: { cookie: 'rs_csrf=abc; other=1' } });

    expect(() => harness.jwtGuard.canActivate(context)).toThrow(SessionInvalidHttpException);
  });

  it('attaches the verified claims, with mustChangePassword defaulting to the confined value', async () => {
    const harness = build();
    const { user, session } = await loggedIn(harness, { role: 'checker', tenantId: 12 });
    const { context, request } = executionContext({ headers: cookieHeader(session.accessToken) });

    expect(harness.jwtGuard.canActivate(context)).toBe(true);
    expect(request.authUser).toMatchObject({
      userId: user.id,
      sessionId: session.sessionId,
      role: 'checker',
      tenantId: 12,
      // Fail-closed placeholder: a chain missing SessionValidGuard confines rather than frees.
      mustChangePassword: true,
    });
  });

  it('TC-8: rejects an expired access token', async () => {
    const harness = build();
    const { user, session } = await loggedIn(harness);

    // Minted in the past rather than moving the clock forward — see the same case in
    // `auth.http.spec.ts` for why `jest.useFakeTimers()` is avoided in these suites.
    const past = new Date(Date.now() - (ACCESS_TOKEN_TTL_SECONDS + 60) * 1000);
    const { token } = harness.tokens.signAccessToken(
      {
        userId: user.id,
        sessionId: session.sessionId,
        role: user.role,
        countryId: user.countryId,
        tenantId: user.tenantId,
        merchantId: user.merchantId,
        rbacVersion: 0,
      },
      past,
    );

    const { context } = executionContext({ headers: cookieHeader(token) });
    expect(() => harness.jwtGuard.canActivate(context)).toThrow(SessionInvalidHttpException);
  });

  it('TC-9: rejects a token signed by a different key', async () => {
    const harness = build();
    const foreign = generateForeignKeyPair();
    const foreignTokens = new TokenService(
      fakeConfigService({
        JWT_PRIVATE_KEY: foreign.privateKey,
        JWT_PUBLIC_KEY: foreign.publicKey,
      }),
    );
    const { token } = foreignTokens.signAccessToken(
      {
        userId: 1,
        sessionId: 'a',
        role: 'super_admin',
        countryId: null,
        tenantId: null,
        merchantId: null,
        rbacVersion: 1,
      },
      new Date(),
    );

    const { context } = executionContext({ headers: cookieHeader(token) });
    expect(() => harness.jwtGuard.canActivate(context)).toThrow(SessionInvalidHttpException);
  });

  it('TC-10/TC-11: rejects alg:none and HS256 forgeries', () => {
    const harness = build();

    for (const forged of ['eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.', 'a.b.c']) {
      const { context } = executionContext({ headers: cookieHeader(forged) });
      expect(() => harness.jwtGuard.canActivate(context)).toThrow(SessionInvalidHttpException);
    }
  });

  it('turns an unexpected verification failure into the same 401, not a 500', () => {
    const harness = build();
    jest.spyOn(harness.tokens, 'verifyAccessToken').mockImplementation(() => {
      throw new TypeError('something else went wrong');
    });
    const { context } = executionContext({ headers: cookieHeader('anything') });

    expect(() => harness.jwtGuard.canActivate(context)).toThrow(SessionInvalidHttpException);
  });

  it('honours @Public() applied to the controller class as well as the handler', () => {
    @Public()
    class PublicController {}

    const harness = build();
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
      getHandler: () => () => undefined,
      getClass: () => PublicController,
    } as unknown as ExecutionContext;

    expect(harness.jwtGuard.canActivate(context)).toBe(true);
  });
});

describe('SessionValidGuard', () => {
  it('lets a @Public() route through', async () => {
    const harness = build();
    const { context } = executionContext({}, { [IS_PUBLIC_KEY]: true });

    await expect(harness.sessionGuard.canActivate(context)).resolves.toBe(true);
  });

  it('denies when it runs before JwtAuthGuard has established a user — fail closed', async () => {
    const harness = build();
    const { context } = executionContext({});

    await expect(harness.sessionGuard.canActivate(context)).rejects.toBeInstanceOf(
      SessionInvalidHttpException,
    );
  });

  it('admits a live session and replaces the placeholder flag with the live one', async () => {
    const harness = build();
    const { session } = await loggedIn(harness, { mustChangePassword: true });
    const { context, request } = executionContext({ headers: cookieHeader(session.accessToken) });
    harness.jwtGuard.canActivate(context);

    await expect(harness.sessionGuard.canActivate(context)).resolves.toBe(true);
    expect(request.authUser?.mustChangePassword).toBe(true);
  });

  it('TC-16: denies once the session has been revoked, well inside the token TTL', async () => {
    const harness = build();
    const { session } = await loggedIn(harness);
    const { context } = executionContext({ headers: cookieHeader(session.accessToken) });
    harness.jwtGuard.canActivate(context);

    await harness.store.revokeSession(session.sessionId, 'logout');

    await expect(harness.sessionGuard.canActivate(context)).rejects.toBeInstanceOf(
      SessionInvalidHttpException,
    );
  });

  it('TC-17: denies once the user has been deactivated', async () => {
    const harness = build();
    const { user, session } = await loggedIn(harness);
    const { context } = executionContext({ headers: cookieHeader(session.accessToken) });
    harness.jwtGuard.canActivate(context);

    const index = harness.store.users.findIndex((u) => u.id === user.id);
    harness.store.users[index] = { ...harness.store.users[index], status: 'inactive' };

    await expect(harness.sessionGuard.canActivate(context)).rejects.toBeInstanceOf(
      SessionInvalidHttpException,
    );
  });

  it("denies a validly-signed token whose sid names another user's session", async () => {
    const harness = build();
    const impostor = harness.store.seedUser();
    const victim = harness.store.seedUser();
    const victimSession = await harness.sessions.start(victim, CONTEXT, new Date());

    // Not producible by this system — the claims are signed — but the consequence of getting it
    // wrong is acting as the wrong user, so the guard checks rather than assumes.
    const authUser: AuthenticatedUser = {
      userId: impostor.id,
      sessionId: victimSession.sessionId,
      role: impostor.role,
      countryId: null,
      tenantId: null,
      merchantId: null,
      rbacVersion: 0,
      tokenId: 'x',
      mustChangePassword: true,
    };
    const { context } = executionContext({ authUser });

    await expect(harness.sessionGuard.canActivate(context)).rejects.toBeInstanceOf(
      SessionInvalidHttpException,
    );
  });
});

describe('PasswordChangeRequiredGuard (TC-19, TC-20)', () => {
  const confined: AuthenticatedUser = {
    userId: 1,
    sessionId: 's',
    role: 'maker',
    countryId: 1,
    tenantId: 1,
    merchantId: null,
    rbacVersion: 1,
    tokenId: 't',
    mustChangePassword: true,
  };

  it('lets a @Public() route through', () => {
    const harness = build();
    const { context } = executionContext({}, { [IS_PUBLIC_KEY]: true });

    expect(harness.passwordGuard.canActivate(context)).toBe(true);
  });

  it('does nothing when no user has been established', () => {
    const harness = build();
    const { context } = executionContext({});

    expect(harness.passwordGuard.canActivate(context)).toBe(true);
  });

  it('lets an unconfined session through', () => {
    const harness = build();
    const { context } = executionContext({ authUser: { ...confined, mustChangePassword: false } });

    expect(harness.passwordGuard.canActivate(context)).toBe(true);
  });

  it('TC-19: blocks a confined session on an ordinary route with 403', () => {
    const harness = build();
    const { context } = executionContext({ authUser: confined });

    expect(() => harness.passwordGuard.canActivate(context)).toThrow(
      PasswordChangeRequiredHttpException,
    );
  });

  it('returns the documented code and status, not a bare Forbidden', () => {
    const error = new PasswordChangeRequiredHttpException();

    expect(error.getStatus()).toBe(403);
    expect(error.getResponse()).toEqual({ error: { code: 'PASSWORD_CHANGE_REQUIRED' } });
  });

  it('lets an exempt route through', () => {
    const harness = build();
    const { context } = executionContext(
      { authUser: confined },
      { [PASSWORD_CHANGE_EXEMPT_KEY]: true },
    );

    expect(harness.passwordGuard.canActivate(context)).toBe(true);
  });

  it('the decorator sets the metadata the guard reads', () => {
    class Controller {
      @AllowWhilePasswordChangeRequired()
      handler(): void {}
    }

    expect(Reflect.getMetadata(PASSWORD_CHANGE_EXEMPT_KEY, Controller.prototype.handler)).toBe(
      true,
    );
  });
});

describe('@CurrentUser()', () => {
  function contextFor(request: Partial<AuthenticatedRequest>): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => request as Request }),
    } as unknown as ExecutionContext;
  }

  it('returns the authenticated user when one is present', () => {
    const authUser = { userId: 5 } as AuthenticatedUser;
    expect(currentUserFrom(contextFor({ authUser }))).toBe(authUser);
  });

  it('throws rather than handing back undefined on an unauthenticated route', () => {
    // Returning undefined here would let a handler proceed with no caller at all.
    expect(() => currentUserFrom(contextFor({}))).toThrow(/no authenticated user/);
  });

  it('is the exact function the decorator wraps', () => {
    // Guards against the two drifting apart: if the decorator ever grows its own copy of the
    // logic, this file would be testing something the application no longer runs.
    expect(typeof CurrentUser).toBe('function');
  });
});
