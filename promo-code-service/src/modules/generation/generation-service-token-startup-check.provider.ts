/**
 * T-PC-056. Fails Nest's own bootstrap loudly when `GENERATION_SERVICE_TOKEN` is unset (TC-8) —
 * the same "never a default, crash immediately rather than start half-configured" contract
 * `src/config/config.schema.ts` already enforces for every other required environment variable
 * (`AGENT-PROTOCOL.md` R4). Copied verbatim in structure from
 * `InternalServiceTokenStartupCheck` (`src/modules/promo-code-config/`, T-PC-011), substituting
 * `GENERATION_SERVICE_TOKEN` throughout — see `generation-service-token.guard.ts`'s own header for
 * why this is a second, independent file rather than a shared base with that guard's own startup
 * check (R11).
 *
 * Deliberately **not** appended to `config.schema.ts` itself, for the identical reason that
 * file's own header documents for `INTERNAL_SERVICE_TOKEN`: `config.schema.spec.ts`'s own
 * `FULL_ENV` fixture (owned by `agent-promo-foundation`, outside this task's file scope, R8) calls
 * `validateConfig(FULL_ENV)` unmocked in one test case, and `src/config/**` is not part of this
 * agent's granted file scope either way. Registered in `GenerationModule`'s own `providers`
 * (this task's own file) instead, so only this module's boot path is affected.
 *
 * **Loads its own `.env*` fallback, independently of `@nestjs/config`** — same reasoning as
 * `InternalServiceTokenStartupCheck`'s own header: `GENERATION_SERVICE_TOKEN` is not declared in
 * `configSchema`, so `@nestjs/config`'s own loader never assigns it back onto `process.env`
 * unless something in this module's own boot path loads it independently.
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

@Injectable()
export class GenerationServiceTokenStartupCheck implements OnModuleInit {
  onModuleInit(): void {
    this.loadDotenvFallback();

    const token = process.env.GENERATION_SERVICE_TOKEN;
    if (!token || token.trim().length === 0) {
      throw new Error(
        'GENERATION_SERVICE_TOKEN is required (see .env.example) — refusing to start with an ' +
          'unconfigured generation-service auth secret.',
      );
    }
  }

  /**
   * Mirrors `config.module.ts`'s own `envFilePath: ['.env.local', '.env.${NODE_ENV}', '.env']`
   * fallback order, resolved against `process.cwd()`. A no-op once `GENERATION_SERVICE_TOKEN` is
   * already present in `process.env` — real deployments set it directly, never via a committed
   * `.env*` file (R4).
   */
  private loadDotenvFallback(): void {
    const nodeEnv = process.env.NODE_ENV || 'development';
    for (const file of ['.env.local', `.env.${nodeEnv}`, '.env']) {
      // `quiet: true` matches this project's other `dotenv.config()` calls — otherwise `dotenv`
      // prints a "tip" line to stdout on every load, including every request-free boot in CI.
      dotenv.config({ path: resolve(process.cwd(), file), quiet: true });
    }
  }
}
