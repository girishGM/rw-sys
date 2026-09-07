import 'reflect-metadata';
import { loadDotenvFilesIntoProcessEnv } from './config/load-dotenv-files';

// T-RR-050. Deliberately BEFORE the `AppModule`/`ConfigModule` imports below, not merely before
// `NestFactory.create` further down — `require('./app.module')` (what TypeScript compiles the
// `import { AppModule }` line below to) transitively `require`s `config.module.ts`, whose
// `NestConfigModule.forRoot(...)` call runs synchronously, up to and including `validate(...)`,
// the moment that `require` executes (`config.module.ts`'s own header). Populating `process.env`
// here first means every var read directly from `process.env` by a later module
// (`FIELD_ENCRYPTION_*`, `CACHE_ADMIN_TOKEN`, ...) is guaranteed to see it, exactly like Jest's
// own `test/database/env.setup.ts` already guarantees for the test suite — see
// `load-dotenv-files.ts`'s own header for the full root-cause writeup. TypeScript preserves the
// textual order of `import`/statement lines when compiling to CommonJS `require()` calls (verified
// empirically for this task), so this ordering is not fragile against a future TS version silently
// hoisting requires — it is standard, spec-guaranteed CommonJS module evaluation order.
loadDotenvFilesIntoProcessEnv();

import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import type { Config } from './config/config.schema';

/**
 * T-RR-004 replaces T-RR-001's direct `process.env.PORT` read with the real, validated
 * `ConfigModule` (`config.module.ts`). `ConfigModule.forRoot({ validate: validateConfig })` runs
 * during `NestFactory.create` below and calls `process.exit(1)` before this function ever reaches
 * `app.listen(...)` if a required bootstrap environment variable is missing or malformed
 * (TC-1/TC-2) — see `config.schema.ts`'s own header for the full contract.
 *
 * Only the primary HTTP listener is bootstrapped from this file — the gRPC server (T-RR-011)
 * and the Kafka consumer (T-RR-012) each get their own standalone bootstrap entry point in
 * Wave 1, mirroring RAP's own "Standalone entry points" convention
 * (`realtime-activity-processing-service/CLAUDE.md`) rather than folding every transport into
 * this single file (T-RR-001 note 9). **Each of those must call `loadDotenvFilesIntoProcessEnv()`
 * as their own first statement too** (T-RR-050) — it is not something `AppModule`/`ConfigModule`
 * does on every consumer's behalf, precisely because it has to run before either is even imported.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService<Config, true>);
  const port = configService.get('PORT', { infer: true });

  // TC-8 (T-RR-001): a port already occupied by another process must fail loudly and exit
  // non-zero, never hang silently — `app.listen(...)` rejects the returned promise on a listener
  // 'error' (e.g. EADDRINUSE), which the catch below turns into a clear, explicit message before
  // exiting.
  await app.listen(port);
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`reward-redemption-service failed to start: ${message}`);
  process.exit(1);
});
