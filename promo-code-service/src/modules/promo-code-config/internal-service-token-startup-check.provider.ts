/**
 * T-PC-011. Fails Nest's own bootstrap loudly when `INTERNAL_SERVICE_TOKEN` is unset — the same
 * "never a default, crash immediately rather than start half-configured" contract
 * `src/config/config.schema.ts` already enforces for every other required environment variable
 * (`AGENT-PROTOCOL.md` R4).
 *
 * Deliberately **not** appended to `config.schema.ts` itself, even though that file's own header
 * explicitly names this exact key as an expected future addition ("later tasks append their own
 * required keys (e.g. the mTLS/internal-service-token material T-PC-031/T-PC-011 need)"): doing
 * so was tried and reverted during this task's implementation, because
 * `config.schema.spec.ts`'s own `FULL_ENV` fixture (owned by `agent-promo-foundation`, outside
 * this task's file scope) calls `validateConfig(FULL_ENV)` **unmocked** in one test case — adding
 * a new required key without that test's own fixture growing to match it makes that call's real,
 * un-stubbed `process.exit(1)` kill the entire Jest worker (see this task's completion report,
 * "Deviations from spec"). Editing that spec file to add the new key to `FULL_ENV` would fix it,
 * but that file is `agent-promo-foundation`'s, not this task's, to change (R8). This provider is
 * the self-contained substitute: registered in `PromoCodeConfigModule`'s own `providers` (this
 * task's own file), so only this module's boot path is affected, and no other task's file needs
 * touching, no other task's test needs updating.
 *
 * **Loads its own `.env*` fallback, independently of `@nestjs/config`.** This was not a stylistic
 * choice — `@nestjs/config`'s own loader (`node_modules/@nestjs/config/dist/config.module.js`,
 * `loadEnvFile`) calls `dotenv.parse(...)` and only ever assigns the *validated* result back onto
 * `process.env` (`assignVariablesToProcess`, fed from `options.validate`'s return value). Since
 * `INTERNAL_SERVICE_TOKEN` is (deliberately, see above) not declared in `configSchema`, `zod`'s
 * own default "strip unknown keys" behaviour means `validateConfig(...)`'s return value never
 * carries it — so `process.env.INTERNAL_SERVICE_TOKEN` would stay `undefined` forever in a real
 * boot even with a fully correct `.env.development`, no matter how this module reads it,
 * **unless something in this module's own boot path loads it independently.** (Every existing
 * test passed regardless, which is what made this easy to miss initially: Jest's own
 * `test/database/env.setup.ts` calls real `dotenv.config(...)` — which *does* mutate
 * `process.env` — as a `setupFiles` entry, entirely independently of `@nestjs/config`, before any
 * of this module's code ever runs.) `dotenv.config()`'s own "never overwrite an already-set key"
 * semantics (same as every other `dotenv.config()` call in this project) mean a real
 * OS/CI-injected `INTERNAL_SERVICE_TOKEN` always wins over any `.env*` file, and the fallback
 * paths/order here exactly mirror `config.module.ts`'s own `envFilePath` array so the two stay
 * consistent.
 *
 * `onModuleInit` runs during `NestFactory.create(AppModule)`/`Test.createTestingModule(...)
 * .compile()` — before any request is ever routed through `InternalServiceTokenGuard` — so a
 * missing secret is a boot-time failure, not a first-request surprise.
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

@Injectable()
export class InternalServiceTokenStartupCheck implements OnModuleInit {
  onModuleInit(): void {
    this.loadDotenvFallback();

    const token = process.env.INTERNAL_SERVICE_TOKEN;
    if (!token || token.trim().length === 0) {
      throw new Error(
        'INTERNAL_SERVICE_TOKEN is required (see .env.example) — refusing to start with an ' +
          'unconfigured internal-service auth secret.',
      );
    }
  }

  /**
   * Mirrors `config.module.ts`'s own `envFilePath: ['.env.local', '.env.${NODE_ENV}', '.env']`
   * fallback order, resolved against `process.cwd()` (the same base `@nestjs/config`'s own
   * relative-path defaults use). A no-op once `INTERNAL_SERVICE_TOKEN` is already present in
   * `process.env` — real deployments set it directly, never via a committed `.env*` file (R4).
   */
  private loadDotenvFallback(): void {
    const nodeEnv = process.env.NODE_ENV || 'development';
    for (const file of ['.env.local', `.env.${nodeEnv}`, '.env']) {
      // `quiet: true` matches `test/database/env.setup.ts`'s own convention — otherwise
      // `dotenv` prints a "tip" line to stdout on every load, including every request-free
      // boot in CI.
      dotenv.config({ path: resolve(process.cwd(), file), quiet: true });
    }
  }
}
