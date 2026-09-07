import 'reflect-metadata';
import { loadDotenvFilesIntoProcessEnv } from './config/load-dotenv-files';

// T-RTS-001. Deliberately BEFORE the `AppModule`/`ConfigModule` imports below, not merely before
// `NestFactory.create` further down — `require('./app.module')` (what TypeScript compiles the
// `import { AppModule }` line below to) transitively `require`s `config.module.ts`, whose
// `NestConfigModule.forRoot(...)` call runs synchronously, up to and including `validate(...)`,
// the moment that `require` executes (`config.module.ts`'s own header). Populating `process.env`
// here first means every var read directly from `process.env` by a later module is guaranteed to
// see it, exactly like `test/env.setup.ts` already guarantees for the test suite. TypeScript
// preserves the textual order of `import`/statement lines when compiling to CommonJS `require()`
// calls, so this ordering is standard, spec-guaranteed CommonJS module evaluation order — not
// fragile against a future TS version silently hoisting requires.
loadDotenvFilesIntoProcessEnv();

import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import type { Config } from './config/config.schema';

/**
 * `ConfigModule.forRoot({ validate: validateConfig })` runs during `NestFactory.create` below and
 * calls `process.exit(1)` before this function ever reaches `app.listen(...)` if a required
 * bootstrap environment variable is missing or malformed — see `config.schema.ts`'s own header for
 * the full contract.
 *
 * Only the primary HTTP listener is bootstrapped from this file — a future gRPC server (Wave 1)
 * and Kafka consumer (Wave 1) each get their own standalone bootstrap entry point, mirroring every
 * sibling service's own "standalone entry points" convention rather than folding every transport
 * into this single file.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService<Config, true>);
  const port = configService.get('PORT', { infer: true });

  // A port already occupied by another process must fail loudly and exit non-zero, never hang
  // silently — `app.listen(...)` rejects the returned promise on a listener 'error' (e.g.
  // EADDRINUSE), which the catch below turns into a clear, explicit message before exiting.
  await app.listen(port);
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`reward-tracking-service failed to start: ${message}`);
  process.exit(1);
});
