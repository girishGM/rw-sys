/**
 * T-011 unit-test support — a stand-in for `@/config/config.module`.
 *
 * `AuthModule` imports `ConfigModule` so its graph is self-contained (`TokenService` needs the
 * RS256 key pair). The real module calls `NestConfigModule.forRoot({ validate })`, which runs
 * `validateEnv` **synchronously at import time** and calls `process.exit(1)` on an incomplete
 * environment — in a Jest worker that kills the run with no failing test to point at, depending
 * only on which `.env` files happen to exist on the machine. Same reasoning, and same shape, as
 * `test/auth/support/fake-database.module.ts`.
 *
 * The key pair is generated per process (see `test-keys.ts`) and never leaves memory (R4).
 */
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fakeConfigService, generateTestKeyPair } from './test-keys';

const keys = generateTestKeyPair();

@Global()
@Module({
  providers: [
    {
      provide: ConfigService,
      useValue: fakeConfigService({
        JWT_PRIVATE_KEY: keys.privateKey,
        JWT_PUBLIC_KEY: keys.publicKey,
      }),
    },
  ],
  exports: [ConfigService],
})
export class ConfigModule {}
