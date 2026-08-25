/**
 * T-012 — rate limiting. Evidences TC-12, TC-13, TC-14, TC-15 and TC-22, and the mechanism half
 * of TC-20/TC-21 (their end-to-end form, with a spy on the real credential service, is in
 * `hardening.e2e-spec.ts`).
 *
 * The guard is driven directly rather than over HTTP. TC-22 needs 1201 login attempts to prove
 * the global ceiling, and TC-14 needs 301: over HTTP against a real login handler that is 1200
 * Argon2 verifies at ~25 ms each, which is half an hour of CPU to assert something that has
 * nothing to do with Argon2. Driving `canActivate` exercises the identical code path — this
 * guard neither reads nor writes anything but the request, the response headers and the store.
 */
import type { ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RateLimitGuard } from '@/common/security/rate-limit.guard';
import {
  RateLimitedHttpException,
  ServiceUnavailableHttpException,
} from '@/common/security/security.exceptions';
import {
  MemoryThrottleStore,
  ThrottleStoreUnavailableError,
  type ThrottleStore,
} from '@/common/security/throttle.store';
import {
  buildThrottleContext,
  normaliseRoute,
  resolveThrottlePolicy,
} from '@/common/security/throttler.config';
import {
  AUTHENTICATED_API_LIMIT,
  LOGIN_GLOBAL_CEILING_PER_MINUTE,
  LOGIN_PER_EMAIL_IP_LIMIT,
  LOGIN_PER_IP_LIMIT,
  UNAUTHENTICATED_API_LIMIT,
  type LoginThrottleLimits,
} from '@/common/security/security.constants';
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

interface RequestShape {
  method?: string;
  path?: string;
  ip?: string;
  body?: unknown;
  cookie?: string;
}

interface Probe {
  context: ExecutionContext;
  headers: Record<string, string>;
}

function probe(shape: RequestShape): Probe {
  const headers: Record<string, string> = {};
  const request = {
    method: shape.method ?? 'POST',
    path: shape.path ?? '/api/v1/auth/login',
    ip: shape.ip ?? '198.51.100.7',
    body: shape.body ?? {},
    headers: shape.cookie === undefined ? {} : { cookie: shape.cookie },
  } as unknown as Request;

  const response = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
  } as unknown as Response;

  return {
    headers,
    context: {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    } as unknown as ExecutionContext,
  };
}

function accessCookie(userId = 42): string {
  const token = tokens.signAccessToken(
    {
      userId,
      sessionId: SESSION_ID,
      role: 'maker',
      countryId: null,
      tenantId: null,
      merchantId: null,
      rbacVersion: 1,
    },
    new Date(),
  ).token;
  return `${ACCESS_COOKIE_NAME}=${encodeURIComponent(token)}`;
}

/**
 * The login ceilings these tests enforce against, stated explicitly rather than inherited from
 * the defaults (T-066 rule 2).
 *
 * T-066 made the two `/auth/login` limits configurable so an e2e environment can raise them. That
 * must not weaken T-012's coverage of the limiter, so this suite now hands the guard the numbers
 * it expects instead of relying on whatever the default resolves to. The values are 02-SECURITY.md
 * §8's, written as literals: if the production defaults were ever changed, these tests would keep
 * proving that the limiter enforces what it is told — which is the property they exist to check —
 * and `login-throttle-override.spec.ts` is what proves the *defaults* are still 5 and 20.
 */
const ENFORCED_LOGIN_LIMITS: LoginThrottleLimits = Object.freeze({
  perEmailIp: 5,
  perIp: 20,
  windowMs: 15 * 60_000,
  relaxed: false,
  factor: 1,
});

function buildGuard(
  store: ThrottleStore = new MemoryThrottleStore(),
  loginLimits: LoginThrottleLimits = ENFORCED_LOGIN_LIMITS,
): {
  guard: RateLimitGuard;
  logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };
} {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { guard: new RateLimitGuard(store, tokens, logger, loginLimits), logger };
}

/** Runs the guard `times` times, returning the error the first failure threw, if any. */
async function hammer(
  guard: RateLimitGuard,
  shape: RequestShape,
  times: number,
): Promise<{ error: unknown; headers: Record<string, string> } | null> {
  for (let i = 0; i < times; i += 1) {
    const attempt = probe(shape);
    try {
      await guard.canActivate(attempt.context);
    } catch (error) {
      return { error, headers: attempt.headers };
    }
  }
  return null;
}

describe('normaliseRoute', () => {
  it.each([
    ['/api/v1/auth/login', '/auth/login'],
    ['/api/v1/auth/login/', '/auth/login'],
    ['/API/V1/Auth/Login', '/auth/login'],
    ['/auth/login', '/auth/login'],
    ['/api/v1/health', '/health'],
    ['/api/v1/', '/'],
    ['/api/v1', '/'],
  ])('normalises %s to %s', (path, expected) => {
    expect(normaliseRoute(path)).toBe(expected);
  });

  it('matches routes exactly, never by prefix', () => {
    const context = buildThrottleContext(
      {
        method: 'POST',
        path: '/api/v1/auth/login-attempts',
        ip: '1.2.3.4',
        headers: {},
      } as unknown as Request,
      null,
    );
    const names = resolveThrottlePolicy(context).rules.map((rule) => rule.name);

    expect(names).not.toContain('login_per_email_ip');
    expect(names).toEqual(['unauthenticated_api_per_ip']);
  });
});

describe('policy resolution', () => {
  const contextFor = (shape: RequestShape, identity: { userId: number } | null = null) =>
    buildThrottleContext(
      {
        method: shape.method ?? 'POST',
        path: shape.path ?? '/api/v1/auth/login',
        ip: shape.ip ?? '198.51.100.7',
        body: shape.body ?? {},
        headers: {},
      } as unknown as Request,
      identity === null ? null : { userId: identity.userId, sessionId: SESSION_ID },
    );

  it('charges login against the global ceiling first, then the per-key limits', () => {
    const rules = resolveThrottlePolicy(contextFor({ body: { email: 'a@b.test' } })).rules;

    expect(rules.map((rule) => rule.name)).toEqual([
      'login_global_ceiling',
      'login_per_email_ip',
      'login_per_ip',
      'unauthenticated_api_per_ip',
    ]);
    expect(rules[0].limit).toBe(LOGIN_GLOBAL_CEILING_PER_MINUTE);
    expect(rules[0].shedWith).toBe('service_unavailable');
    expect(rules[1].limit).toBe(LOGIN_PER_EMAIL_IP_LIMIT);
    expect(rules[2].limit).toBe(LOGIN_PER_IP_LIMIT);
  });

  it('marks exactly the three routes AR-11 names as fail-closed', () => {
    expect(resolveThrottlePolicy(contextFor({ path: '/api/v1/auth/login' })).failClosed).toBe(true);
    expect(resolveThrottlePolicy(contextFor({ path: '/api/v1/auth/refresh' })).failClosed).toBe(
      true,
    );
    expect(resolveThrottlePolicy(contextFor({ path: '/api/v1/auth/mfa/verify' })).failClosed).toBe(
      true,
    );
    expect(
      resolveThrottlePolicy(contextFor({ path: '/api/v1/auth/forgot-password' })).failClosed,
    ).toBe(false);
    expect(resolveThrottlePolicy(contextFor({ path: '/api/v1/campaigns' })).failClosed).toBe(false);
    // A GET to a fail-closed path is not a login attempt and must not inherit the posture.
    expect(
      resolveThrottlePolicy(contextFor({ path: '/api/v1/auth/login', method: 'GET' })).failClosed,
    ).toBe(false);
  });

  it('keys the general bucket by user when authenticated and by IP when not', () => {
    const authenticated = resolveThrottlePolicy(
      contextFor({ path: '/api/v1/campaigns', method: 'GET' }, { userId: 7 }),
    ).rules;
    expect(authenticated).toHaveLength(1);
    expect(authenticated[0].name).toBe('authenticated_api_per_user');
    expect(authenticated[0].limit).toBe(AUTHENTICATED_API_LIMIT);
    expect(authenticated[0].key).toBe('api:user:7');

    const anonymous = resolveThrottlePolicy(
      contextFor({ path: '/api/v1/campaigns', method: 'GET' }),
    ).rules;
    expect(anonymous[0].name).toBe('unauthenticated_api_per_ip');
    expect(anonymous[0].limit).toBe(UNAUTHENTICATED_API_LIMIT);
  });

  it('exempts the liveness probe entirely', () => {
    expect(
      resolveThrottlePolicy(contextFor({ path: '/api/v1/health', method: 'GET' })).rules,
    ).toEqual([]);
  });

  it('never puts an email address in a counter key', () => {
    const rules = resolveThrottlePolicy(
      contextFor({ path: '/api/v1/auth/forgot-password', body: { email: 'Someone@Example.test' } }),
    ).rules;

    expect(rules.map((rule) => rule.name)).toContain('forgot_password_per_email');
    for (const rule of rules) {
      expect(rule.key.toLowerCase()).not.toContain('someone');
      expect(rule.key).not.toContain('@');
    }
  });

  it('folds letter-case so one address cannot become two counters', () => {
    const lower = resolveThrottlePolicy(contextFor({ body: { email: 'user@example.test' } }));
    const upper = resolveThrottlePolicy(contextFor({ body: { email: ' USER@Example.TEST ' } }));

    expect(upper.rules[1].key).toBe(lower.rules[1].key);
  });

  it.each([[{}], [{ email: 42 }], [{ email: '   ' }], [null], ['not an object']])(
    'tolerates a body of %p without throwing',
    (body) => {
      expect(() => resolveThrottlePolicy(contextFor({ body }))).not.toThrow();
    },
  );

  it('keys refresh by the presented token, falling back to the IP when absent', () => {
    const withCookie = buildThrottleContext(
      {
        method: 'POST',
        path: '/api/v1/auth/refresh',
        ip: '198.51.100.7',
        body: {},
        headers: { cookie: '__Host-rs_rt=an-opaque-refresh-token' },
      } as unknown as Request,
      null,
    );
    const rules = resolveThrottlePolicy(withCookie).rules;

    expect(rules[0].key).toMatch(/^refresh:sid:/);
    expect(rules[0].key).not.toContain('an-opaque-refresh-token');

    const withoutCookie = resolveThrottlePolicy(contextFor({ path: '/api/v1/auth/refresh' }));
    expect(withoutCookie.rules[0].key).toMatch(/^refresh:ip:/);
  });

  it('falls back to a placeholder when the request has no IP at all', () => {
    const context = buildThrottleContext(
      { method: 'GET', path: '/api/v1/campaigns', body: {}, headers: {} } as unknown as Request,
      null,
    );
    expect(context.ip).toBe('unknown');
  });
});

describe('enforcement', () => {
  it('TC-12: the 6th login for one email+IP inside 15 minutes is 429 with Retry-After', async () => {
    const { guard } = buildGuard();
    const shape = { body: { email: 'victim@example.test' }, ip: '198.51.100.7' };

    const outcome = await hammer(guard, shape, 6);

    expect(outcome).not.toBeNull();
    expect(outcome?.error).toBeInstanceOf(RateLimitedHttpException);
    expect((outcome?.error as RateLimitedHttpException).getStatus()).toBe(429);
    expect(Number(outcome?.headers['Retry-After'])).toBeGreaterThan(0);
    expect(Number(outcome?.headers['Retry-After'])).toBeLessThanOrEqual(15 * 60);
  });

  it('lets the first five through', async () => {
    const { guard } = buildGuard();
    const outcome = await hammer(guard, { body: { email: 'ok@example.test' } }, 5);
    expect(outcome).toBeNull();
  });

  it('TC-13: the 21st login from one IP across different emails is 429', async () => {
    const { guard } = buildGuard();

    // Each address is used at most four times, so the per-email+IP limit of five is never the
    // thing that trips — this is the per-IP limit doing its job.
    for (let i = 0; i < 20; i += 1) {
      const attempt = probe({ body: { email: `user-${i}@example.test` }, ip: '203.0.113.5' });
      await expect(guard.canActivate(attempt.context)).resolves.toBe(true);
    }

    const twentyFirst = probe({ body: { email: 'user-21@example.test' }, ip: '203.0.113.5' });
    await expect(guard.canActivate(twentyFirst.context)).rejects.toBeInstanceOf(
      RateLimitedHttpException,
    );
  });

  it('keeps counters for different IPs independent', async () => {
    const { guard } = buildGuard();
    await hammer(guard, { body: { email: 'a@example.test' }, ip: '198.51.100.1' }, 5);

    const otherIp = probe({ body: { email: 'a@example.test' }, ip: '198.51.100.2' });
    await expect(guard.canActivate(otherIp.context)).resolves.toBe(true);
  });

  it('TC-14: the 301st authenticated API call in a minute is 429', async () => {
    const { guard } = buildGuard();
    const shape = { method: 'GET', path: '/api/v1/campaigns', cookie: accessCookie(99) };

    for (let i = 0; i < AUTHENTICATED_API_LIMIT; i += 1) {
      const attempt = probe(shape);
      await expect(guard.canActivate(attempt.context)).resolves.toBe(true);
    }

    const overLimit = probe(shape);
    await expect(guard.canActivate(overLimit.context)).rejects.toBeInstanceOf(
      RateLimitedHttpException,
    );
  });

  it('the 61st unauthenticated call from one IP in a minute is 429', async () => {
    const { guard } = buildGuard();
    const shape = { method: 'GET', path: '/api/v1/campaigns', ip: '192.0.2.44' };

    const outcome = await hammer(guard, shape, UNAUTHENTICATED_API_LIMIT + 1);
    expect(outcome?.error).toBeInstanceOf(RateLimitedHttpException);
  });

  it('TC-15: the 429 body names no limit, no quota and no key', async () => {
    const { guard } = buildGuard();
    const outcome = await hammer(guard, { body: { email: 'victim@example.test' } }, 6);
    const body = (outcome?.error as RateLimitedHttpException).getResponse();

    // `RATE_LIMITED` is the code itself, which the client needs; everything that would identify
    // *which* limit tripped, or how much of it is left, must be absent.
    expect(body).toEqual({ error: { code: 'RATE_LIMITED' } });
    const serialised = JSON.stringify(body);
    expect(serialised).not.toMatch(/remaining|quota|retry|reset|login_per|per_ip|per_email/i);
    expect(serialised).not.toMatch(/victim|example\.test|198\.51\.100/);
    expect(serialised).not.toMatch(/\d/);
  });

  it('charges the coarser counters even after a finer one has already tripped', async () => {
    const { guard } = buildGuard();

    // Trip the per-email+IP limit ten times over, all from one address.
    await hammer(guard, { body: { email: 'noisy@example.test' }, ip: '198.51.100.9' }, 15);

    // A different address from the same IP must now be near the per-IP limit, not fresh: if the
    // per-IP counter had stopped incrementing once the finer rule tripped, an attacker could
    // keep it artificially low for free.
    const outcome = await hammer(
      guard,
      { body: { email: 'other@example.test' }, ip: '198.51.100.9' },
      6,
    );
    expect(outcome?.error).toBeInstanceOf(RateLimitedHttpException);
  });

  it('never sets an X-RateLimit-* quota header', async () => {
    const { guard } = buildGuard();
    const attempt = probe({ body: { email: 'a@example.test' } });
    await guard.canActivate(attempt.context);

    expect(Object.keys(attempt.headers)).toEqual([]);
  });

  it('does not throttle the liveness probe', async () => {
    const { guard } = buildGuard();
    const outcome = await hammer(guard, { method: 'GET', path: '/api/v1/health' }, 500);
    expect(outcome).toBeNull();
  });
});

describe('TC-22: the global login ceiling (AR-12)', () => {
  it('sheds with 503 once the aggregate is exceeded, with every key under its own limit', async () => {
    const { guard } = buildGuard();

    // 300 distinct email+IP pairs, four attempts each: every pair stays under the per-email+IP
    // limit of five and the per-IP limit of twenty, so neither per-key control can be what
    // trips. 300 × 4 = 1200 = the ceiling exactly.
    const pairs = 300;
    const perPair = 4;
    expect(pairs * perPair).toBe(LOGIN_GLOBAL_CEILING_PER_MINUTE);
    expect(perPair).toBeLessThan(LOGIN_PER_EMAIL_IP_LIMIT);
    expect(perPair).toBeLessThan(LOGIN_PER_IP_LIMIT);

    for (let pair = 0; pair < pairs; pair += 1) {
      const shape = {
        body: { email: `distributed-${pair}@example.test` },
        ip: `10.${Math.floor(pair / 256)}.${pair % 256}.1`,
      };
      const outcome = await hammer(guard, shape, perPair);
      expect(outcome).toBeNull();
    }

    const oneMore = probe({ body: { email: 'distributed-fresh@example.test' }, ip: '10.9.9.9' });
    await expect(guard.canActivate(oneMore.context)).rejects.toBeInstanceOf(
      ServiceUnavailableHttpException,
    );
  });

  it('answers the shed request 503 with Retry-After and no diagnostic detail', async () => {
    const store = new MemoryThrottleStore();
    const { guard } = buildGuard(store);

    // Pre-charge the global counter straight into the store: the ceiling's behaviour, not the
    // arithmetic of reaching it, is what this asserts.
    for (let i = 0; i < LOGIN_GLOBAL_CEILING_PER_MINUTE; i += 1) {
      await store.consume('login:global', 60_000, Date.now());
    }

    const attempt = probe({ body: { email: 'anyone@example.test' } });
    await expect(guard.canActivate(attempt.context)).rejects.toMatchObject({
      response: { error: { code: 'SERVICE_UNAVAILABLE' } },
    });
    expect(Number(attempt.headers['Retry-After'])).toBeGreaterThan(0);
  });
});

describe('AR-11: the asymmetric store-outage policy', () => {
  const failingStore: ThrottleStore = {
    kind: 'unavailable',
    consume: async () => {
      throw new ThrottleStoreUnavailableError('ECONNREFUSED');
    },
  };

  it.each(['/api/v1/auth/login', '/api/v1/auth/refresh', '/api/v1/auth/mfa/verify'])(
    'fails %s closed with 503 when the store is unreachable',
    async (path) => {
      const { guard, logger } = buildGuard(failingStore);
      const attempt = probe({ path, body: { email: 'a@example.test' } });

      await expect(guard.canActivate(attempt.context)).rejects.toBeInstanceOf(
        ServiceUnavailableHttpException,
      );
      expect(attempt.headers['Retry-After']).toBeDefined();
      expect(logger.error).toHaveBeenCalled();
      expect(logger.error.mock.calls[0][0]).toContain('AR-11');
    },
  );

  it('TC-21: fails a non-auth authenticated call open, so an outage is not a total outage', async () => {
    const { guard, logger } = buildGuard(failingStore);
    const attempt = probe({
      method: 'GET',
      path: '/api/v1/campaigns',
      cookie: accessCookie(11),
    });

    await expect(guard.canActivate(attempt.context)).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.warn.mock.calls[0][0]).toContain('Failing open');
  });

  it('fails an unauthenticated non-auth call open too', async () => {
    const { guard } = buildGuard(failingStore);
    const attempt = probe({ method: 'GET', path: '/api/v1/campaigns' });
    await expect(guard.canActivate(attempt.context)).resolves.toBe(true);
  });

  it('keeps evaluating the remaining rules when one key fails on a fail-open route', async () => {
    const flaky: ThrottleStore = {
      kind: 'memory',
      consume: async (key) => {
        if (key.startsWith('forgot:')) throw new ThrottleStoreUnavailableError('key down');
        return { count: 999, resetAt: Date.now() + 60_000 };
      },
    };
    const { guard } = buildGuard(flaky);
    const attempt = probe({
      path: '/api/v1/auth/forgot-password',
      body: { email: 'a@example.test' },
    });

    // The forgot-password counter is unavailable, but the general per-IP counter is not — and it
    // is already over its limit, so the request is still rejected.
    await expect(guard.canActivate(attempt.context)).rejects.toBeInstanceOf(
      RateLimitedHttpException,
    );
  });

  it('uses a real Nest logger when none is injected', async () => {
    const guard = new RateLimitGuard(new MemoryThrottleStore(), tokens);
    const attempt = probe({ method: 'GET', path: '/api/v1/campaigns' });
    await expect(guard.canActivate(attempt.context)).resolves.toBe(true);
  });
});
