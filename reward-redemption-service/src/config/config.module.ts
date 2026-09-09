import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validateConfig } from './config.schema';
import { getEnvFileNames } from './env-file-names';

/**
 * T-RR-004. `@Global()` so every module (health, and every later Wave 1+ module) can inject
 * `ConfigService<Config>` without re-importing this. `validate` (config.schema.ts) runs
 * synchronously the moment this file is imported — `NestConfigModule.forRoot(...)` runs up to
 * (and including) its `validate(...)` call before its own first `await`, so a failure calls
 * `process.exit(1)` before `main.ts` ever reaches `NestFactory.create`, let alone any controller,
 * guard or DB connection being constructed (see `main.ts`'s own header — this is exactly why
 * `load-dotenv-files.ts`, T-RR-050, has to run before *this file is imported*, not merely before
 * `NestFactory.create`). Direct port of RAP's own `src/config/config.module.ts`, not a
 * reimplementation.
 *
 * `envFilePath` here (`getEnvFileNames()`, T-RR-050) must resolve to the exact same three file
 * names, in the same precedence order, as `load-dotenv-files.ts`'s own eager `process.env`
 * loader — see that shared helper's header for why a divergence between the two would silently
 * reintroduce this task's own bug for a different var.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validate: validateConfig,
      envFilePath: getEnvFileNames(),
    }),
  ],
  exports: [NestConfigModule],
})
export class ConfigModule {}
