/**
 * T-012 — `SecurityModule`'s DI wiring.
 *
 * Everything asserted here fails at boot in production and nowhere else. Two of them would fail
 * *silently*: an `APP_GUARD` entry registered with `useClass` instead of `useExisting` gives a
 * second guard instance with a second counter store — halving every rate limit without any
 * visible symptom — and a guard registered in the wrong order puts CSRF ahead of rate limiting,
 * contradicting 00-ARCHITECTURE.md §6.
 */
jest.mock('@/database/database.module', () =>
  jest.requireActual('../auth/support/fake-database.module'),
);
jest.mock('@/config/config.module', () => jest.requireActual('./support/fake-config.module'));

import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SecurityModule } from '@/common/security/security.module';
import { CsrfGuard } from '@/common/security/csrf.guard';
import { RateLimitGuard } from '@/common/security/rate-limit.guard';
import {
  MemoryThrottleStore,
  RedisThrottleStore,
  THROTTLE_STORE,
  UnavailableThrottleStore,
  type ThrottleStore,
} from '@/common/security/throttle.store';
import { fakeSecurityConfigService } from './support/fake-config.module';

describe('SecurityModule', () => {
  async function compile(configOverrides: Record<string, unknown> = {}) {
    return Test.createTestingModule({ imports: [SecurityModule] })
      .overrideProvider(ConfigService)
      .useValue(fakeSecurityConfigService(configOverrides))
      .compile();
  }

  it('resolves both guards and the counter store', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(RateLimitGuard)).toBeInstanceOf(RateLimitGuard);
    expect(moduleRef.get(CsrfGuard)).toBeInstanceOf(CsrfGuard);
    expect(moduleRef.get<ThrottleStore>(THROTTLE_STORE)).toBeInstanceOf(MemoryThrottleStore);
  });

  it('registers both global guards with useExisting, in the §6 order (3 then 4)', () => {
    const providers = Reflect.getMetadata('providers', SecurityModule) as Array<{
      provide?: unknown;
      useExisting?: unknown;
      useClass?: unknown;
    }>;
    const globalGuards = providers.filter((provider) => provider?.provide === APP_GUARD);

    // Order: RateLimitGuard (§6 position 3) before CsrfGuard (position 4).
    expect(globalGuards.map((provider) => provider.useExisting)).toEqual([
      RateLimitGuard,
      CsrfGuard,
    ]);
    // `useExisting`, never `useClass`: a second RateLimitGuard instance would come with a
    // second counter store, silently halving every limit.
    for (const guard of globalGuards) {
      expect(guard.useClass).toBeUndefined();
    }
  });

  it('builds a Redis-backed store when REDIS_URL is set and a client is available', async () => {
    // No Redis client is installed in this workspace, so a configured URL is expected to yield
    // the deliberately-unavailable store rather than a silent memory fallback (AR-11).
    const moduleRef = await compile({ REDIS_URL: 'redis://localhost:6379', APP_INSTANCE_COUNT: 3 });
    const store = moduleRef.get<ThrottleStore>(THROTTLE_STORE);

    expect(store).not.toBeInstanceOf(MemoryThrottleStore);
    expect(store).toBeInstanceOf(UnavailableThrottleStore);
    expect(RedisThrottleStore.name).toBe('RedisThrottleStore');
  });

  it('defaults the instance count when the environment omits it', async () => {
    const moduleRef = await compile({ APP_INSTANCE_COUNT: undefined });
    expect(moduleRef.get<ThrottleStore>(THROTTLE_STORE)).toBeInstanceOf(MemoryThrottleStore);
  });
});
