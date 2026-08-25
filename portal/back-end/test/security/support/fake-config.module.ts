/**
 * T-012 unit-test support — a stand-in for `@/config/config.module`, for the same reason
 * `test/auth/support/fake-config.module.ts` exists: the real module runs `validateEnv`
 * synchronously at import time and calls `process.exit(1)` on an incomplete environment, which
 * in a Jest worker kills the run with no failing test to point at.
 *
 * It differs from the auth one in a single way, and that difference is the point of having it:
 * T-012's environment keys are **optional**, so this `ConfigService` answers `undefined` for
 * them rather than throwing. A fake that threw would make `SecurityModule` untestable in
 * exactly the configuration it will most often run in — none of them set.
 *
 * The key pair is generated per process and never leaves memory (R4).
 */
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.schema';
import { generateTestKeyPair } from '../../auth/support/test-keys';

const keys = generateTestKeyPair();

/** Keys with no configured value answer `undefined`, exactly as the real optional ones do. */
export function fakeSecurityConfigService(
  overrides: Record<string, unknown> = {},
): ConfigService<Env, true> {
  const values: Record<string, unknown> = {
    JWT_PRIVATE_KEY: keys.privateKey,
    JWT_PUBLIC_KEY: keys.publicKey,
    APP_INSTANCE_COUNT: 1,
    ...overrides,
  };

  return {
    get(key: string): unknown {
      return values[key];
    },
  } as unknown as ConfigService<Env, true>;
}

@Global()
@Module({
  providers: [{ provide: ConfigService, useValue: fakeSecurityConfigService() }],
  exports: [ConfigService],
})
export class ConfigModule {}
