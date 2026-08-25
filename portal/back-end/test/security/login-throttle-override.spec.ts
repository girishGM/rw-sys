/**
 * T-066 — the login-ceiling test-environment override.
 *
 * The task's constraint is that **production limits do not change**, so most of what is asserted
 * here is a refusal: every malformed input, and every input at all under `NODE_ENV=production`,
 * must yield 02-SECURITY.md §8's numbers.
 *
 * Two deliberate choices about *how* it is asserted, both from AGENT-PROTOCOL §3 ("assert the
 * observable property, not the implementation string"):
 *
 * 1. The production expectations are written as **literals** — 5, 20, 15 minutes — not as
 *    `LOGIN_PER_EMAIL_IP_LIMIT`. Importing the constant and comparing the resolver's output to it
 *    is a tautology: it passes whatever the constant says, including if somebody changes it to
 *    500. The literals are the contract 02-SECURITY.md §8 states, so they are what is checked.
 * 2. The headline cases are driven through the **real `RateLimitGuard` and a real counter store**,
 *    asserting the thing a client actually experiences (a `RateLimitedHttpException` on the 6th
 *    attempt), not the shape of the policy object. A policy whose `limit` field reads 5 but which
 *    is never consulted would pass the second kind of test and fail the first.
 */
import type { ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RateLimitGuard } from '@/common/security/rate-limit.guard';
import { RateLimitedHttpException } from '@/common/security/security.exceptions';
import { MemoryThrottleStore } from '@/common/security/throttle.store';
import { buildThrottleContext, resolveThrottlePolicy } from '@/common/security/throttler.config';
import {
  MAX_LOGIN_THROTTLE_RELAX_FACTOR,
  PRODUCTION_LOGIN_THROTTLE_LIMITS,
  loginThrottleRelaxedWarning,
  resolveLoginThrottleLimits,
  type LoginThrottleLimits,
} from '@/common/security/security.constants';
import { TokenService } from '@/modules/auth/services/token.service';
import { fakeConfigService, generateTestKeyPair } from '../auth/support/test-keys';

/** 02-SECURITY.md §8, written out rather than imported — see this file's header. */
const PRODUCTION_PER_EMAIL_IP = 5;
const PRODUCTION_PER_IP = 20;
const PRODUCTION_WINDOW_MS = 15 * 60_000;

let tokens: TokenService;

beforeAll(() => {
  const keys = generateTestKeyPair();
  tokens = new TokenService(
    fakeConfigService({ JWT_PRIVATE_KEY: keys.privateKey, JWT_PUBLIC_KEY: keys.publicKey }),
  );
});

function loginProbe(email: string, ip: string): ExecutionContext {
  const request = {
    method: 'POST',
    path: '/api/v1/auth/login',
    ip,
    body: { email },
    headers: {},
  } as unknown as Request;
  const response = { setHeader: () => undefined } as unknown as Response;

  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
}

/**
 * Drives real login attempts through the real guard until one is shed, returning how many
 * succeeded first. Distinct IPs per attempt are avoided on purpose: the point is one account from
 * one address, which is what the e2e suite actually does.
 */
async function attemptsBeforeShed(
  limits: LoginThrottleLimits,
  max: number,
  email = 'e2e@portal.test',
  ip = '198.51.100.9',
): Promise<number> {
  // A stub logger, not the real one: the guard warns on every shed, and a bare `new Logger()`
  // would print that to the test output.
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const guard = new RateLimitGuard(new MemoryThrottleStore(), tokens, logger, limits);
  let allowed = 0;

  for (let i = 0; i < max; i += 1) {
    try {
      await guard.canActivate(loginProbe(email, ip));
      allowed += 1;
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitedHttpException);
      // The status is asserted as the literal 429, not as `HttpStatus.TOO_MANY_REQUESTS` and not
      // only as the exception class. The class is the mechanism; 429 is what a client actually
      // judges, and it is what this task's verification steps are written in terms of ("the 6th
      // is 429"). Asserting only the class would keep passing if the exception were ever
      // reconstructed around a different status — which is the T-058 failure mode.
      expect((error as RateLimitedHttpException).getStatus()).toBe(429);
      return allowed;
    }
  }
  return allowed;
}

describe('T-066 TC-1/TC-2 — the default is the production policy', () => {
  it('sheds the 6th login for one email from one IP when nothing is configured', async () => {
    // TC-1, reproduced: this is the exact behaviour that blocked T-050's suite, and it must
    // survive this task unchanged.
    expect(
      await attemptsBeforeShed(resolveLoginThrottleLimits({ raw: undefined, nodeEnv: 'test' }), 10),
    ).toBe(PRODUCTION_PER_EMAIL_IP);
  });

  it('resolves to exactly 5 / 20 / 15 min with no override set', () => {
    const limits = resolveLoginThrottleLimits({ raw: undefined, nodeEnv: 'test' });

    expect(limits.perEmailIp).toBe(PRODUCTION_PER_EMAIL_IP);
    expect(limits.perIp).toBe(PRODUCTION_PER_IP);
    expect(limits.windowMs).toBe(PRODUCTION_WINDOW_MS);
    expect(limits.relaxed).toBe(false);
    expect(limits.factor).toBe(1);
  });

  it('uses the production policy when resolveThrottlePolicy is called with no limits at all', () => {
    // The default-parameter path: a caller that forgets the second argument must not get a
    // weaker limit, or an undefined one.
    const rules = resolveThrottlePolicy(
      buildThrottleContext(
        {
          method: 'POST',
          path: '/api/v1/auth/login',
          ip: '203.0.113.4',
          body: { email: 'a@b.test' },
          headers: {},
        } as unknown as Request,
        null,
      ),
    ).rules;

    expect(rules.find((rule) => rule.name === 'login_per_email_ip')?.limit).toBe(
      PRODUCTION_PER_EMAIL_IP,
    );
    expect(rules.find((rule) => rule.name === 'login_per_ip')?.limit).toBe(PRODUCTION_PER_IP);
  });

  it('exposes production defaults on the exported constant', () => {
    expect(PRODUCTION_LOGIN_THROTTLE_LIMITS).toEqual({
      perEmailIp: PRODUCTION_PER_EMAIL_IP,
      perIp: PRODUCTION_PER_IP,
      windowMs: PRODUCTION_WINDOW_MS,
      relaxed: false,
      factor: 1,
    });
  });
});

describe('T-066 TC-3 — a valid override outside production takes effect', () => {
  it('raises both login ceilings by the factor', () => {
    const limits = resolveLoginThrottleLimits({ raw: '8', nodeEnv: 'test' });

    expect(limits.perEmailIp).toBe(40);
    expect(limits.perIp).toBe(160);
    expect(limits.relaxed).toBe(true);
    expect(limits.factor).toBe(8);
  });

  it('actually admits more than 5 logins through the real guard', async () => {
    const limits = resolveLoginThrottleLimits({ raw: '8', nodeEnv: 'test' });

    // The observable point of the whole task: the 6th login no longer 429s.
    expect(await attemptsBeforeShed(limits, 41)).toBe(40);
  });

  it('leaves the 15-minute window alone', () => {
    expect(resolveLoginThrottleLimits({ raw: '8', nodeEnv: 'test' }).windowMs).toBe(
      PRODUCTION_WINDOW_MS,
    );
  });

  it.each(['development', 'test', undefined, null, '', 'staging'])(
    'honours the override when NODE_ENV is %p',
    (nodeEnv) => {
      expect(resolveLoginThrottleLimits({ raw: '3', nodeEnv }).relaxed).toBe(true);
    },
  );
});

describe('T-066 TC-4 — production ignores the override entirely', () => {
  it.each(['2', '8', '40', '999999', String(MAX_LOGIN_THROTTLE_RELAX_FACTOR)])(
    'ignores LOGIN_THROTTLE_RELAX_FACTOR=%s under NODE_ENV=production',
    (raw) => {
      const limits = resolveLoginThrottleLimits({ raw, nodeEnv: 'production' });

      expect(limits.perEmailIp).toBe(PRODUCTION_PER_EMAIL_IP);
      expect(limits.perIp).toBe(PRODUCTION_PER_IP);
      expect(limits.relaxed).toBe(false);
      expect(limits.factor).toBe(1);
    },
  );

  it('still sheds the 6th login in production with the override set as high as it goes', async () => {
    // TC-4 is called out as "the point of this task", so it is also asserted through the guard,
    // not only through the resolver.
    const limits = resolveLoginThrottleLimits({ raw: '999999', nodeEnv: 'production' });

    expect(await attemptsBeforeShed(limits, 10)).toBe(PRODUCTION_PER_EMAIL_IP);
  });
});

describe('T-066 TC-5 — malformed input falls back to production, never to unlimited', () => {
  it.each([
    ['garbage', 'abc'],
    ['negative', '-1'],
    ['zero', '0'],
    ['one (a no-op factor)', '1'],
    ['empty', ''],
    ['whitespace', '   '],
    ['fractional', '2.5'],
    ['exponent notation', '1e9'],
    ['hex', '0x10'],
    ['trailing garbage', '5x'],
    ['leading plus', '+5'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
    ['null', null],
    ['undefined', undefined],
    ['a comma list', '2,3'],
    ['beyond Number.MAX_SAFE_INTEGER', '99999999999999999999'],
  ])('falls back to production limits for %s', (_label, raw) => {
    const limits = resolveLoginThrottleLimits({ raw, nodeEnv: 'test' });

    expect(limits.perEmailIp).toBe(PRODUCTION_PER_EMAIL_IP);
    expect(limits.perIp).toBe(PRODUCTION_PER_IP);
    expect(limits.windowMs).toBe(PRODUCTION_WINDOW_MS);
    expect(limits.relaxed).toBe(false);
  });

  it('clamps an over-large factor rather than honouring it', () => {
    const limits = resolveLoginThrottleLimits({ raw: '100000', nodeEnv: 'test' });

    expect(limits.factor).toBe(MAX_LOGIN_THROTTLE_RELAX_FACTOR);
    expect(limits.perEmailIp).toBe(PRODUCTION_PER_EMAIL_IP * MAX_LOGIN_THROTTLE_RELAX_FACTOR);
  });

  it('is bounded: no input produces an unlimited or non-finite limit', () => {
    const candidates = ['2', '40', '999999', '99999999999999999999', 'abc', '-1', '0', ''];

    for (const raw of candidates) {
      const limits = resolveLoginThrottleLimits({ raw, nodeEnv: 'test' });

      expect(Number.isSafeInteger(limits.perEmailIp)).toBe(true);
      expect(Number.isSafeInteger(limits.perIp)).toBe(true);
      expect(limits.perEmailIp).toBeGreaterThanOrEqual(PRODUCTION_PER_EMAIL_IP);
      expect(limits.perEmailIp).toBeLessThanOrEqual(
        PRODUCTION_PER_EMAIL_IP * MAX_LOGIN_THROTTLE_RELAX_FACTOR,
      );
      expect(limits.perIp).toBeLessThanOrEqual(PRODUCTION_PER_IP * MAX_LOGIN_THROTTLE_RELAX_FACTOR);
    }
  });

  it('never resolves to a limit below the production one', () => {
    // The direction of the knob is part of the control: it may only ever raise.
    for (const raw of ['2', '3', '40', '999999', 'abc', undefined]) {
      const limits = resolveLoginThrottleLimits({ raw, nodeEnv: 'test' });

      expect(limits.perEmailIp).toBeGreaterThanOrEqual(PRODUCTION_PER_EMAIL_IP);
      expect(limits.perIp).toBeGreaterThanOrEqual(PRODUCTION_PER_IP);
    }
  });
});

describe('T-066 TC-6 — the boot warning', () => {
  it('names the variable, the new numbers and the production numbers', () => {
    const limits = resolveLoginThrottleLimits({ raw: '8', nodeEnv: 'test' });
    const message = loginThrottleRelaxedWarning(limits);

    expect(message).toContain('LOGIN_THROTTLE_RELAX_FACTOR=8');
    expect(message).toContain('login_per_email_ip=40');
    expect(message).toContain('login_per_ip=160');
    // The reader has to be able to see what the numbers *should* be, not just what they are.
    expect(message).toContain(`production ${PRODUCTION_PER_EMAIL_IP}`);
    expect(message).toContain(`production ${PRODUCTION_PER_IP}`);
    expect(message).toMatch(/RELAXED/);
    expect(message).toContain('NODE_ENV=production');
  });
});

describe('T-066 TC-8 — no other throttle rule moves', () => {
  function limitFor(name: string, path: string, limits: LoginThrottleLimits): number | undefined {
    const context = buildThrottleContext(
      {
        method: 'POST',
        path,
        ip: '203.0.113.9',
        body: { email: 'a@b.test', mfaPendingToken: 'pending-token-value' },
        headers: { cookie: 'rs_refresh=refresh-token-value' },
      } as unknown as Request,
      null,
    );
    return resolveThrottlePolicy(context, limits).rules.find((rule) => rule.name === name)?.limit;
  }

  it.each([
    ['login_global_ceiling', '/api/v1/auth/login', 1200],
    ['mfa_verify_per_ip', '/api/v1/auth/mfa/verify', 5],
    ['mfa_per_pending_token', '/api/v1/auth/mfa/verify', 5],
    ['refresh_per_session', '/api/v1/auth/refresh', 30],
    ['forgot_password_per_email', '/api/v1/auth/forgot-password', 3],
    ['unauthenticated_api_per_ip', '/api/v1/campaigns', 60],
  ])('leaves %s at %i even with the override at maximum', (name, path, expected) => {
    const relaxed = resolveLoginThrottleLimits({ raw: '999999', nodeEnv: 'test' });

    expect(limitFor(name as string, path as string, relaxed)).toBe(expected);
  });

  it('leaves the fail-closed route set untouched', () => {
    const relaxed = resolveLoginThrottleLimits({ raw: '40', nodeEnv: 'test' });
    const context = buildThrottleContext(
      {
        method: 'POST',
        path: '/api/v1/auth/login',
        ip: '203.0.113.9',
        body: {},
        headers: {},
      } as unknown as Request,
      null,
    );

    expect(resolveThrottlePolicy(context, relaxed).failClosed).toBe(true);
  });
});

describe('T-066 — purity', () => {
  it('resolveThrottlePolicy does not read process.env', () => {
    // Implementation note 1: configuration is read once, through the config layer, never on the
    // hot path. Deleting the variable mid-flight must not change an already-resolved policy.
    const previous = process.env.LOGIN_THROTTLE_RELAX_FACTOR;
    const limits = resolveLoginThrottleLimits({ raw: '8', nodeEnv: 'test' });

    process.env.LOGIN_THROTTLE_RELAX_FACTOR = '2';
    const context = buildThrottleContext(
      {
        method: 'POST',
        path: '/api/v1/auth/login',
        ip: '203.0.113.9',
        body: { email: 'a@b.test' },
        headers: {},
      } as unknown as Request,
      null,
    );

    expect(
      resolveThrottlePolicy(context, limits).rules.find(
        (rule) => rule.name === 'login_per_email_ip',
      )?.limit,
    ).toBe(40);

    if (previous === undefined) delete process.env.LOGIN_THROTTLE_RELAX_FACTOR;
    else process.env.LOGIN_THROTTLE_RELAX_FACTOR = previous;
  });

  it('returns a frozen object, so a caller cannot raise a limit after resolution', () => {
    const limits = resolveLoginThrottleLimits({ raw: '8', nodeEnv: 'test' });

    expect(Object.isFrozen(limits)).toBe(true);
    expect(() => {
      (limits as { perEmailIp: number }).perEmailIp = 999_999;
    }).toThrow(TypeError);
    expect(limits.perEmailIp).toBe(40);
  });
});
