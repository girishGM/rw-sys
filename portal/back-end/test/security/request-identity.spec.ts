/**
 * T-012 — the shared, memoised "who is this?" used by `RateLimitGuard` and `CsrfGuard`.
 *
 * The property worth pinning here is the conservative one: **every** way a token can be
 * unusable resolves to `null` rather than throwing, because this runs on `@Public()` routes
 * where an exception would be a 500 for an anonymous caller. The memoisation matters too — both
 * guards run on every mutating request, and without the cache each one would pay an RSA
 * verification.
 */
import type { Request } from 'express';
import { resolveVerifiedIdentity } from '@/common/security/request-identity';
import { TokenService } from '@/modules/auth/services/token.service';
import { ACCESS_COOKIE_NAME } from '@/modules/auth/session.constants';
import { fakeConfigService, generateTestKeyPair } from '../auth/support/test-keys';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';

let tokens: TokenService;

beforeAll(() => {
  const keys = generateTestKeyPair();
  tokens = new TokenService(
    fakeConfigService({ JWT_PRIVATE_KEY: keys.privateKey, JWT_PUBLIC_KEY: keys.publicKey }),
  );
});

function signedAt(issuedAt: Date, userId = 42): string {
  return tokens.signAccessToken(
    {
      userId,
      sessionId: SESSION_ID,
      role: 'maker',
      countryId: null,
      tenantId: null,
      merchantId: null,
      rbacVersion: 1,
    },
    issuedAt,
  ).token;
}

function requestWith(cookie: string | undefined, authUser?: unknown): Request {
  return {
    headers: cookie === undefined ? {} : { cookie },
    ...(authUser === undefined ? {} : { authUser }),
  } as unknown as Request;
}

describe('resolveVerifiedIdentity', () => {
  it('prefers an identity a previous guard already established', () => {
    const request = requestWith(undefined, { userId: 7, sessionId: 'from-jwt-auth-guard' });
    expect(resolveVerifiedIdentity(request, tokens)).toEqual({
      userId: 7,
      sessionId: 'from-jwt-auth-guard',
    });
  });

  it('verifies the access cookie when no guard has run yet', () => {
    const request = requestWith(
      `${ACCESS_COOKIE_NAME}=${encodeURIComponent(signedAt(new Date()))}`,
    );
    expect(resolveVerifiedIdentity(request, tokens)).toEqual({ userId: 42, sessionId: SESSION_ID });
  });

  it('memoises, so two guards on one request verify the token once', () => {
    const request = requestWith(
      `${ACCESS_COOKIE_NAME}=${encodeURIComponent(signedAt(new Date()))}`,
    );
    const verify = jest.spyOn(tokens, 'verifyAccessToken');

    const first = resolveVerifiedIdentity(request, tokens);
    const second = resolveVerifiedIdentity(request, tokens);

    expect(second).toBe(first);
    expect(verify).toHaveBeenCalledTimes(1);
    verify.mockRestore();
  });

  it('memoises a null answer too, so a bad cookie is not re-verified either', () => {
    const request = requestWith(`${ACCESS_COOKIE_NAME}=rubbish`);
    const verify = jest.spyOn(tokens, 'verifyAccessToken');

    expect(resolveVerifiedIdentity(request, tokens)).toBeNull();
    expect(resolveVerifiedIdentity(request, tokens)).toBeNull();

    expect(verify).toHaveBeenCalledTimes(1);
    verify.mockRestore();
  });

  it.each([
    ['no cookie header at all', undefined],
    ['a cookie header with no access cookie', 'other=value'],
    ['an empty access cookie', `${ACCESS_COOKIE_NAME}=`],
    ['a malformed token', `${ACCESS_COOKIE_NAME}=not.a.jwt`],
  ])('returns null for %s, without throwing', (_label, cookie) => {
    expect(() => resolveVerifiedIdentity(requestWith(cookie), tokens)).not.toThrow();
    expect(resolveVerifiedIdentity(requestWith(cookie), tokens)).toBeNull();
  });

  it('honours an explicit clock, so an expired token is anonymous', () => {
    const issued = new Date('2026-08-17T10:00:00Z');
    const cookie = `${ACCESS_COOKIE_NAME}=${encodeURIComponent(signedAt(issued))}`;

    // Inside the 15-minute access-token lifetime.
    expect(
      resolveVerifiedIdentity(requestWith(cookie), tokens, new Date('2026-08-17T10:05:00Z')),
    ).toEqual({ userId: 42, sessionId: SESSION_ID });

    // Past it.
    expect(
      resolveVerifiedIdentity(requestWith(cookie), tokens, new Date('2026-08-17T11:00:00Z')),
    ).toBeNull();
  });
});
