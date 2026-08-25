/**
 * T-066 TC-6 and TC-9 — the two halves that live outside the pure resolver: does the variable
 * actually *arrive*, and is it *announced* when it is in force.
 *
 * TC-9 is the interesting one, and it has a trap worth naming. `@nestjs/config` calls
 * `assignVariablesToProcess(validatedConfig)` when a `validate` function is supplied, and
 * `validateEnv` is a zod `safeParse` over a plain `z.object`, which **strips unknown keys**. So a
 * variable that is not declared in `envSchema` is silently dropped when it comes from a `.env`
 * file — it is never assigned to `process.env` and `ConfigService.get` cannot see it either. That
 * is T-057's D-3, and it is precisely how this task's new knob could have been written to look
 * correct while never once taking effect.
 *
 * The negative control below is what makes this a test rather than a change-detector: it proves
 * that an *undeclared* variable really is stripped by the same call in the same conditions. If
 * `LOGIN_THROTTLE_RELAX_FACTOR` were removed from `envSchema`, the first test would fail and the
 * second would still pass — which is the asymmetry AGENT-PROTOCOL §3 asks for.
 */
jest.mock('@/database/database.module', () =>
  jest.requireActual('../auth/support/fake-database.module'),
);
jest.mock('@/config/config.module', () => jest.requireActual('./support/fake-config.module'));

import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { validateEnv } from '@/config/env.schema';
import { SecurityModule } from '@/common/security/security.module';
import { RateLimitGuard } from '@/common/security/rate-limit.guard';
import {
  LOGIN_THROTTLE_LIMITS,
  type LoginThrottleLimits,
} from '@/common/security/security.constants';
import { fakeSecurityConfigService } from './support/fake-config.module';

/**
 * A complete, valid environment — every required key present so `validateEnv` cannot reach its
 * `process.exit(1)` branch inside a Jest worker. None of these values is a credential for
 * anything (R4): they are syntactically valid placeholders consumed only by zod's `.min(1)`.
 */
function completeEnv(extra: Record<string, string> = {}): Record<string, unknown> {
  return {
    NODE_ENV: 'test',
    JWT_PRIVATE_KEY: 'placeholder-not-a-key',
    JWT_PUBLIC_KEY: 'placeholder-not-a-key',
    DB_HOST: 'localhost',
    DB_NAME: 'placeholder',
    DB_APP_USERNAME: 'placeholder',
    DB_APP_PASSWORD: 'placeholder',
    DB_MIGRATION_USERNAME: 'placeholder',
    DB_MIGRATION_PASSWORD: 'placeholder',
    ...extra,
  };
}

describe('T-066 TC-9 — the variable survives validateEnv', () => {
  it('keeps LOGIN_THROTTLE_RELAX_FACTOR in the validated object', () => {
    const validated = validateEnv(completeEnv({ LOGIN_THROTTLE_RELAX_FACTOR: '8' }));

    // This is the value @nestjs/config assigns back to process.env and serves from
    // ConfigService. If the key were absent from envSchema it would not be here at all.
    expect(validated.LOGIN_THROTTLE_RELAX_FACTOR).toBe('8');
  });

  it('negative control: an undeclared variable IS stripped by the same call', () => {
    const validated = validateEnv(
      completeEnv({ SOME_UNDECLARED_T066_VARIABLE: 'present-on-the-way-in' }),
    );

    expect(validated).not.toHaveProperty('SOME_UNDECLARED_T066_VARIABLE');
  });

  it('keeps it as a raw string, so garbage cannot stop the boot', () => {
    // Deliberately NOT z.coerce.number(): that would fail validation and call process.exit(1) on
    // a typo in a test-environment convenience knob. Garbage must degrade, not detonate.
    const validated = validateEnv(completeEnv({ LOGIN_THROTTLE_RELAX_FACTOR: 'abc' }));

    expect(validated.LOGIN_THROTTLE_RELAX_FACTOR).toBe('abc');
  });

  it('is optional — a complete environment without it validates cleanly', () => {
    const validated = validateEnv(completeEnv());

    expect(validated.LOGIN_THROTTLE_RELAX_FACTOR).toBeUndefined();
  });
});

describe('T-066 TC-6 — SecurityModule announces a relaxed limiter at boot', () => {
  async function compile(overrides: Record<string, unknown>) {
    return Test.createTestingModule({ imports: [SecurityModule] })
      .overrideProvider(ConfigService)
      .useValue(fakeSecurityConfigService(overrides))
      .compile();
  }

  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  function warnings(): string[] {
    return warn.mock.calls.map((call) => String(call[0]));
  }

  it('logs a loud warning naming the relaxed numbers', async () => {
    const moduleRef = await compile({
      NODE_ENV: 'test',
      LOGIN_THROTTLE_RELAX_FACTOR: '8',
    });

    const relaxedWarning = warnings().find((message) => message.includes('RELAXED'));
    expect(relaxedWarning).toBeDefined();
    expect(relaxedWarning).toContain('login_per_email_ip=40');

    expect(moduleRef.get<LoginThrottleLimits>(LOGIN_THROTTLE_LIMITS).perEmailIp).toBe(40);
  });

  it('says nothing, and changes nothing, when no override is set', async () => {
    const moduleRef = await compile({ NODE_ENV: 'test' });

    expect(warnings().some((message) => message.includes('RELAXED'))).toBe(false);
    expect(moduleRef.get<LoginThrottleLimits>(LOGIN_THROTTLE_LIMITS).perEmailIp).toBe(5);
  });

  it('says nothing, and changes nothing, under NODE_ENV=production', async () => {
    const moduleRef = await compile({
      NODE_ENV: 'production',
      LOGIN_THROTTLE_RELAX_FACTOR: '40',
    });

    expect(warnings().some((message) => message.includes('RELAXED'))).toBe(false);

    const limits = moduleRef.get<LoginThrottleLimits>(LOGIN_THROTTLE_LIMITS);
    expect(limits.perEmailIp).toBe(5);
    expect(limits.perIp).toBe(20);
    expect(limits.relaxed).toBe(false);
  });

  it('the guard actually receives the provided limits', async () => {
    // Guards against the wiring being present but unused — the provider existing while
    // RateLimitGuard silently keeps its production fallback.
    const moduleRef = await compile({
      NODE_ENV: 'test',
      LOGIN_THROTTLE_RELAX_FACTOR: '3',
    });

    const guard = moduleRef.get(RateLimitGuard);

    expect((guard as unknown as { loginLimits: LoginThrottleLimits }).loginLimits.perEmailIp).toBe(
      15,
    );
  });
});
