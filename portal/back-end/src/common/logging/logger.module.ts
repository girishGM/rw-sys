/**
 * T-019 — the application logger itself.
 *
 * **Moved here from T-052 by architect decision on 2026-08-18** (see this task's implementation
 * note 6a and `progress.json`). The reasoning, recorded because it explains why a Wave 4 file
 * appears in a Wave 1 task: T-052 sits at the end of the build, so under the original split *no
 * real application logger existed anywhere until nearly the end* — every task before it would run
 * with no usable log output, and T-017's "no PII in logs" guarantee would be provable only in
 * isolation rather than end to end. This task already builds the log schema
 * (`tracing/logger.config.ts`) and the correlation plumbing every line needs, so bootstrapping the
 * transport belongs with it. T-052 keeps health checks, metrics, Docker and deployment, and now
 * **extends** this logger rather than creating one.
 *
 * ---
 *
 * ## What this module actually changes
 *
 * Nest's default `ConsoleLogger` prints prose to stdout: `[Nest] 1234 - 18/08/2026, 09:12:33 AM
 * LOG [AuditService] …`. Every `new Logger(X)` in the codebase — and there are dozens, in
 * `AuditService`, `ErrorNormalizationFilter`, `SessionService`, `PolicyCacheService — writes
 * through it. `main.ts` calls `app.useLogger(...)` with the provider this module registers, which
 * redirects all of them, with **no change at any call site**, into the §3 JSON envelope, through
 * the T-017 masking serialiser, carrying the correlation id from the `AsyncLocalStorage` context.
 *
 * That is what makes notes 1, 5 and 6 of the task file real rather than aspirational, and it is
 * what TC-17 checks end to end.
 *
 * ## Why the policy engine is bound at bootstrap rather than injected
 *
 * `logger.config.ts`'s header explains this at length and it is the one non-obvious thing in this
 * file: importing `DataProtectionModule` here would pull it forward in Nest's module-registration
 * order and silently invert the `mask → encrypt` interceptor ordering that 07-DATA-PROTECTION.md
 * §8 fixes. So the lookup is resolved out of the container **after** every module is registered,
 * through `ModuleRef` with `strict: false`, which reads the graph without joining it.
 *
 * Until that happens — during boot, and forever in a process that has no data-protection module,
 * such as the migration CLI — every line still goes through T-014's pattern-based `redact()`.
 * Binding can only ever make masking stricter.
 */
import { hostname } from 'node:os';
import { Global, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { WinstonModule } from 'nest-winston';
import { ConfigModule } from '@/config/config.module';
import { PolicyCacheService } from '@/common/data-protection/policy-cache.service';
import {
  SERVICE_NAME,
  buildLoggerOptions,
  logPolicyBinding,
  resolveLogLevel,
} from '@/common/tracing/logger.config';
import type { Env } from '@/config/env.schema';

@Global()
@Module({
  imports: [
    ConfigModule,
    WinstonModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const env = config.get('NODE_ENV', { infer: true });
        return buildLoggerOptions({
          level: resolveLogLevel(config.get('LOG_LEVEL', { infer: true }), env),
          service: {
            name: SERVICE_NAME,
            // Unset in development, where the answer is "whatever is checked out". A literal is
            // better than a lie: `0.0.0-dev` sorts below every release and is obviously not one.
            version: config.get('SERVICE_VERSION', { infer: true }) ?? '0.0.0-dev',
            env,
            // §3's `instance` distinguishes pods in an aggregated view. The hostname is the value
            // every orchestrator already sets to something meaningful.
            instance: config.get('INSTANCE_ID', { infer: true }) ?? hostname(),
          },
        });
      },
    }),
  ],
  exports: [WinstonModule],
})
export class LoggerModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(LoggerModule.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  /**
   * Installs the T-017 policy engine into the log pipeline, if this process has one.
   *
   * `onApplicationBootstrap` rather than `onModuleInit`: `PolicyCacheService` loads its rows in
   * its own `onModuleInit`, and Nest runs every module's `onModuleInit` before any module's
   * `onApplicationBootstrap`, so by this point the cache has either loaded or failed loudly.
   *
   * A process without the module — the migration CLI, a unit test, a future worker — logs on with
   * T-014 redaction and says so once. That is a *narrower* failure than it looks: the pattern
   * masker covers every key the policy table would have covered as `secret`, and the policy
   * engine's added value is the PII treatments (`mask`, `hash`) and the fail-closed ladder.
   */
  onApplicationBootstrap(): void {
    try {
      logPolicyBinding.bind(this.moduleRef.get(PolicyCacheService, { strict: false }));
    } catch {
      this.logger.warn(
        'No PolicyCacheService in this process, so log masking is running on T-014 key-pattern ' +
          'redaction only (07-DATA-PROTECTION.md §7 treatments are not applied). Expected in the ' +
          'migration CLI and in tests; unexpected in the API process.',
      );
    }
  }
}
