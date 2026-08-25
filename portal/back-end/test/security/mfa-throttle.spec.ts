/**
 * T-055 — the per-`mfaPendingToken` rate limit added to T-012's policy
 * (implementation note 7: *"`/auth/mfa/verify` and `/auth/mfa/recover` are rate-limited (5/15 min
 * per `mfaPendingToken`), same shape as login itself — a 6-digit TOTP code is brute-forceable
 * without one"*).
 *
 * Kept in its own file rather than appended to `rate-limit.guard.spec.ts` so the addition is
 * reviewable on its own and T-012's suite is untouched.
 *
 * The property that matters: a challenge is bounded **across source addresses**. The per-IP limit
 * already in the policy bounds one address across every challenge, which a botnet walks straight
 * around — one guess per address, a million addresses, and a 6-digit code falls.
 */
import type { Request } from 'express';
import { buildThrottleContext, resolveThrottlePolicy } from '@/common/security/throttler.config';
import { MFA_PER_PENDING_TOKEN_LIMIT } from '@/common/security/security.constants';
import { MFA_PENDING_COOKIE_NAME } from '@/modules/auth/mfa.constants';

const TOKEN = 'mfa1.eyJ1IjoxfQ.c2lnbmF0dXJl';

function contextFor(shape: {
  path: string;
  method?: string;
  body?: unknown;
  cookie?: string;
}): ReturnType<typeof buildThrottleContext> {
  return buildThrottleContext(
    {
      method: shape.method ?? 'POST',
      path: shape.path,
      ip: '198.51.100.7',
      body: shape.body ?? {},
      headers: shape.cookie === undefined ? {} : { cookie: shape.cookie },
    } as unknown as Request,
    null,
  );
}

function ruleNames(context: ReturnType<typeof buildThrottleContext>): string[] {
  return resolveThrottlePolicy(context).rules.map((rule) => rule.name);
}

describe('the per-pending-token limit', () => {
  it('applies to /auth/mfa/verify, whether the token arrives in the body or the cookie', () => {
    const fromBody = contextFor({
      path: '/api/v1/auth/mfa/verify',
      body: { mfaPendingToken: TOKEN, totpCode: '123456' },
    });
    const fromCookie = contextFor({
      path: '/api/v1/auth/mfa/verify',
      cookie: `${MFA_PENDING_COOKIE_NAME}=${encodeURIComponent(TOKEN)}`,
    });

    expect(ruleNames(fromBody)).toContain('mfa_per_pending_token');
    expect(ruleNames(fromCookie)).toContain('mfa_per_pending_token');

    // Same challenge ⇒ same counter, whichever transport carried it: a caller cannot pick the
    // transport that misses the limit.
    const bodyRule = resolveThrottlePolicy(fromBody).rules.find(
      (rule) => rule.name === 'mfa_per_pending_token',
    );
    const cookieRule = resolveThrottlePolicy(fromCookie).rules.find(
      (rule) => rule.name === 'mfa_per_pending_token',
    );
    expect(bodyRule?.key).toBe(cookieRule?.key);
    expect(bodyRule?.limit).toBe(MFA_PER_PENDING_TOKEN_LIMIT);
  });

  it('applies to /auth/mfa/recover as well — a recovery code is guessable too', () => {
    expect(
      ruleNames(
        contextFor({
          path: '/api/v1/auth/mfa/recover',
          body: { mfaPendingToken: TOKEN, recoveryCode: 'ABCD-EFGH-JKMN' },
        }),
      ),
    ).toContain('mfa_per_pending_token');
  });

  it('does NOT apply to /auth/mfa/enrol — there is nothing to guess there', () => {
    expect(
      ruleNames(contextFor({ path: '/api/v1/auth/mfa/enrol', body: { mfaPendingToken: TOKEN } })),
    ).not.toContain('mfa_per_pending_token');
  });

  it('is absent when no token was presented, leaving the per-IP buckets to do the work', () => {
    const names = ruleNames(contextFor({ path: '/api/v1/auth/mfa/verify' }));

    expect(names).not.toContain('mfa_per_pending_token');
    expect(names).toContain('mfa_verify_per_ip');
  });

  it('never puts the token itself in the counter key', () => {
    const rules = resolveThrottlePolicy(
      contextFor({ path: '/api/v1/auth/mfa/verify', body: { mfaPendingToken: TOKEN } }),
    ).rules;

    for (const rule of rules) {
      expect(rule.key).not.toContain(TOKEN);
      expect(rule.key).not.toContain('mfa1.');
    }
  });

  it('composes with the per-IP limit rather than replacing it', () => {
    expect(
      ruleNames(contextFor({ path: '/api/v1/auth/mfa/verify', body: { mfaPendingToken: TOKEN } })),
    ).toEqual(['mfa_verify_per_ip', 'mfa_per_pending_token', 'unauthenticated_api_per_ip']);
  });

  it('ignores a GET, which is not a challenge attempt', () => {
    expect(
      ruleNames(
        contextFor({
          path: '/api/v1/auth/mfa/verify',
          method: 'GET',
          body: { mfaPendingToken: TOKEN },
        }),
      ),
    ).not.toContain('mfa_per_pending_token');
  });

  it.each([
    [{ mfaPendingToken: 42 }],
    [{ mfaPendingToken: '   ' }],
    [{ mfaPendingToken: null }],
    [{}],
    [null],
    ['not an object'],
  ])('tolerates the body %p without throwing', (body) => {
    expect(() =>
      resolveThrottlePolicy(contextFor({ path: '/api/v1/auth/mfa/verify', body })),
    ).not.toThrow();
  });

  it('truncates an oversized token before it is hashed into a key', () => {
    const huge = 'm'.repeat(50_000);
    const rules = resolveThrottlePolicy(
      contextFor({ path: '/api/v1/auth/mfa/verify', body: { mfaPendingToken: huge } }),
    ).rules;
    const rule = rules.find((candidate) => candidate.name === 'mfa_per_pending_token');

    expect(rule).toBeDefined();
    expect(rule?.key.length).toBeLessThan(64);
  });
});
