/**
 * T-055 — `MfaPendingConfinementGuard` (4b) and `MfaRequiredGuard` (6c).
 *
 * Both are held to the 100% bar `jest.config.js` applies to `src/modules/auth/**`, and both are
 * exercised the same way `guards.spec.ts` exercises T-011's three: a hand-built `ExecutionContext`
 * so every branch — including the ones that only occur when the chain is mis-wired — is reachable
 * without a server.
 *
 * The assertion that matters most is the last one in each describe: **neither guard ever writes
 * `request.authUser`**. That is what makes it safe for one of them to run in front of
 * authentication (`mfa-required.guard.ts` header), and it is a property a future edit could
 * quietly break.
 */
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import { MFA_EXEMPT_KEY } from '@/modules/auth/decorators/mfa-exempt.decorator';
import { IS_PUBLIC_KEY } from '@/modules/auth/decorators/public.decorator';
import {
  MfaPendingConfinementGuard,
  MfaRequiredGuard,
  isMfaExempt,
} from '@/modules/auth/guards/mfa-required.guard';
import { MFA_ERROR_CODE, MFA_PENDING_COOKIE_NAME } from '@/modules/auth/mfa.constants';
import {
  MfaEnrolmentRequiredHttpException,
  MfaPendingHttpException,
} from '@/modules/auth/mfa.exceptions';
import { MfaPendingTokenService } from '@/modules/auth/services/mfa-pending-token.service';
import { FakeMfaStore } from './support/fake-mfa-store';
import {
  fakeConfigService,
  generateForeignKeyPair,
  generateTestKeyPair,
} from './support/test-keys';

interface ContextShape {
  readonly cookie?: string;
  readonly authUser?: AuthenticatedUser;
  readonly metadata?: Record<string, unknown>;
  readonly type?: 'http' | 'rpc';
}

const SUPER_ADMIN: AuthenticatedUser = {
  userId: 5,
  sessionId: '0b6f1f4e-1b1e-4d3a-9d4a-0a1b2c3d4e5f',
  role: 'super_admin',
  countryId: null,
  tenantId: null,
  merchantId: null,
  rbacVersion: 1,
  tokenId: 'token-1',
  mustChangePassword: false,
};

/** A context whose reflector answers from a plain metadata map. */
function contextFor(shape: ContextShape): {
  context: ExecutionContext;
  reflector: Reflector;
  request: AuthenticatedRequest;
} {
  const request = {
    headers: shape.cookie === undefined ? {} : { cookie: shape.cookie },
    authUser: shape.authUser,
  } as unknown as AuthenticatedRequest;

  const handler = () => undefined;
  const controller = class Controller {};
  const metadata = shape.metadata ?? {};

  const reflector = {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;

  const context = {
    getType: () => shape.type ?? 'http',
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  return { context, reflector, request };
}

function pendingTokens(): MfaPendingTokenService {
  const keys = generateTestKeyPair();
  return new MfaPendingTokenService(
    fakeConfigService({ JWT_PRIVATE_KEY: keys.privateKey, JWT_PUBLIC_KEY: keys.publicKey }),
  );
}

describe('isMfaExempt', () => {
  it('reads the decorator, handler-then-class', () => {
    const { context, reflector } = contextFor({ metadata: { [MFA_EXEMPT_KEY]: true } });
    expect(isMfaExempt(reflector, context)).toBe(true);

    const plain = contextFor({});
    expect(isMfaExempt(plain.reflector, plain.context)).toBe(false);
  });

  it('treats a non-`true` value as not exempt', () => {
    const { context, reflector } = contextFor({ metadata: { [MFA_EXEMPT_KEY]: 'yes' } });
    expect(isMfaExempt(reflector, context)).toBe(false);
  });
});

describe('MfaPendingConfinementGuard (position 4b)', () => {
  const tokens = pendingTokens();
  const guardWith = (reflector: Reflector) => new MfaPendingConfinementGuard(reflector, tokens);

  const cookieFor = (userId: number, enrolled: boolean): string =>
    `${MFA_PENDING_COOKIE_NAME}=${encodeURIComponent(tokens.mint({ userId, enrolled }))}`;

  it('TC-4: answers 403 MFA_ENROLMENT_REQUIRED for an unenrolled pending caller', () => {
    const { context, reflector } = contextFor({ cookie: cookieFor(5, false) });

    expect(() => guardWith(reflector).canActivate(context)).toThrow(
      MfaEnrolmentRequiredHttpException,
    );

    try {
      guardWith(reflector).canActivate(context);
    } catch (error) {
      expect((error as MfaEnrolmentRequiredHttpException).getStatus()).toBe(403);
      expect((error as MfaEnrolmentRequiredHttpException).getResponse()).toEqual({
        error: { code: MFA_ERROR_CODE.ENROLMENT_REQUIRED },
      });
    }
  });

  it('answers 403 MFA_PENDING for an enrolled caller who has not answered the challenge', () => {
    const { context, reflector } = contextFor({ cookie: cookieFor(5, true) });

    try {
      guardWith(reflector).canActivate(context);
      throw new Error('expected the guard to deny');
    } catch (error) {
      expect(error).toBeInstanceOf(MfaPendingHttpException);
      expect((error as MfaPendingHttpException).getResponse()).toEqual({
        error: { code: MFA_ERROR_CODE.PENDING },
      });
    }
  });

  it('TC-5: allows the exempt routes', () => {
    const { context, reflector } = contextFor({
      cookie: cookieFor(5, false),
      metadata: { [MFA_EXEMPT_KEY]: true },
    });

    expect(guardWith(reflector).canActivate(context)).toBe(true);
  });

  it('allows @Public() routes, so a confined caller can always start again', () => {
    const { context, reflector } = contextFor({
      cookie: cookieFor(5, false),
      metadata: { [IS_PUBLIC_KEY]: true },
    });

    expect(guardWith(reflector).canActivate(context)).toBe(true);
  });

  it('says nothing when there is no pending cookie', () => {
    const { context, reflector } = contextFor({});
    expect(guardWith(reflector).canActivate(context)).toBe(true);

    const other = contextFor({ cookie: 'unrelated=value' });
    expect(guardWith(other.reflector).canActivate(other.context)).toBe(true);
  });

  // The foreign token is minted by a service holding an *unrelated* signing key — note the
  // `generateForeignKeyPair`, not `generateTestKeyPair`, which is memoised per process and would
  // hand back the very key this guard verifies with.
  const foreignKeys = generateForeignKeyPair();
  const foreignToken = new MfaPendingTokenService(
    fakeConfigService({
      JWT_PRIVATE_KEY: foreignKeys.privateKey,
      JWT_PUBLIC_KEY: foreignKeys.publicKey,
    }),
  ).mint({ userId: 5, enrolled: false });

  it.each([
    ['garbage', 'not-a-token'],
    ['a foreign signature', foreignToken],
  ])('treats %s as absent, leaving the 401 to the chain behind it', (_label, value) => {
    const { context, reflector } = contextFor({
      cookie: `${MFA_PENDING_COOKIE_NAME}=${encodeURIComponent(value)}`,
    });

    expect(guardWith(reflector).canActivate(context)).toBe(true);
  });

  it('treats an expired token as absent', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-18T12:00:00.000Z'));
    const cookie = cookieFor(5, false);
    jest.setSystemTime(new Date('2026-08-18T12:06:00.000Z'));

    const { context, reflector } = contextFor({ cookie });
    expect(guardWith(reflector).canActivate(context)).toBe(true);

    jest.useRealTimers();
  });

  it('ignores non-HTTP transports', () => {
    const { context, reflector } = contextFor({ cookie: cookieFor(5, false), type: 'rpc' });
    expect(guardWith(reflector).canActivate(context)).toBe(true);
  });

  it('never establishes an identity — it can only deny', () => {
    const { context, reflector, request } = contextFor({ cookie: cookieFor(5, false) });

    expect(() => guardWith(reflector).canActivate(context)).toThrow();
    expect(request.authUser).toBeUndefined();
  });
});

describe('MfaRequiredGuard (position 6c)', () => {
  function build(store: FakeMfaStore, reflector: Reflector): MfaRequiredGuard {
    return new MfaRequiredGuard(reflector, store);
  }

  it('denies an authenticated super_admin whose account is not enrolled', async () => {
    const store = new FakeMfaStore();
    store.seedUser({ id: SUPER_ADMIN.userId, role: 'super_admin', mfaEnabled: false });
    const { context, reflector } = contextFor({ authUser: SUPER_ADMIN });

    await expect(build(store, reflector).canActivate(context)).rejects.toBeInstanceOf(
      MfaEnrolmentRequiredHttpException,
    );
  });

  it('admits an authenticated super_admin who is enrolled', async () => {
    const store = new FakeMfaStore();
    store.seedUser({ id: SUPER_ADMIN.userId, role: 'super_admin', mfaEnabled: true });
    const { context, reflector } = contextFor({ authUser: SUPER_ADMIN });

    await expect(build(store, reflector).canActivate(context)).resolves.toBe(true);
  });

  it('fails closed when the user row has vanished under a live session', async () => {
    const store = new FakeMfaStore();
    const { context, reflector } = contextFor({ authUser: SUPER_ADMIN });

    await expect(build(store, reflector).canActivate(context)).rejects.toBeInstanceOf(
      MfaEnrolmentRequiredHttpException,
    );
  });

  it('TC-15: never touches a non-super_admin — not even with a database read', async () => {
    const store = new FakeMfaStore();
    const spy = jest.spyOn(store, 'isMfaEnabled');
    const { context, reflector } = contextFor({
      authUser: { ...SUPER_ADMIN, role: 'country_admin', countryId: 1 },
    });

    await expect(build(store, reflector).canActivate(context)).resolves.toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('allows the exempt routes, so an unenrolled super_admin can still enrol and log out', async () => {
    const store = new FakeMfaStore();
    store.seedUser({ id: SUPER_ADMIN.userId, role: 'super_admin', mfaEnabled: false });
    const { context, reflector } = contextFor({
      authUser: SUPER_ADMIN,
      metadata: { [MFA_EXEMPT_KEY]: true },
    });

    await expect(build(store, reflector).canActivate(context)).resolves.toBe(true);
  });

  it('allows @Public() routes and non-HTTP transports', async () => {
    const store = new FakeMfaStore();
    store.seedUser({ id: SUPER_ADMIN.userId, mfaEnabled: false });

    const publicRoute = contextFor({ authUser: SUPER_ADMIN, metadata: { [IS_PUBLIC_KEY]: true } });
    await expect(
      build(store, publicRoute.reflector).canActivate(publicRoute.context),
    ).resolves.toBe(true);

    const rpc = contextFor({ authUser: SUPER_ADMIN, type: 'rpc' });
    await expect(build(store, rpc.reflector).canActivate(rpc.context)).resolves.toBe(true);
  });

  it('says nothing when no guard in front of it established a user', async () => {
    // A mis-ordered chain. This guard must not *grant* on it — `JwtAuthGuard` and
    // `SessionValidGuard` are the ones that deny an anonymous request, and they have run.
    const store = new FakeMfaStore();
    const { context, reflector } = contextFor({});

    await expect(build(store, reflector).canActivate(context)).resolves.toBe(true);
  });

  it('never establishes or alters an identity', async () => {
    const store = new FakeMfaStore();
    store.seedUser({ id: SUPER_ADMIN.userId, role: 'super_admin', mfaEnabled: true });
    const { context, reflector, request } = contextFor({ authUser: SUPER_ADMIN });

    await build(store, reflector).canActivate(context);

    expect(request.authUser).toBe(SUPER_ADMIN);
  });
});
