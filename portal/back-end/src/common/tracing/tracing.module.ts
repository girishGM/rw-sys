/**
 * T-019 — DI wiring for the tracing layer.
 *
 * A module file is an addition to this task's declared *Files owned* list, following the
 * precedent T-010…T-018 each set (`auth.module.ts`, `security.module.ts`, `rbac.module.ts`,
 * `audit.module.ts`, `data-protection.module.ts`, `transport-crypto.module.ts`); recorded as a
 * deviation in the completion report.
 *
 * ---
 *
 * ## Three jobs, and the ordering constraint on each
 *
 * **1. `CorrelationMiddleware`, applied to every route.** Nest applies middleware in
 * module-registration order, so `TracingModule` is listed **first** in `AppModule.imports` — see
 * the note there. It must be: every other component's log lines, and the SQL comment, and the
 * audit row's `correlation_id`, all read a context that only exists because this middleware ran.
 *
 * **2. `SpanService`, exported.** The free functions in `span.service.ts` are the primary API
 * (that file explains why); this is the injectable form for Wave 3 and for T-045.
 *
 * **3. The SQL comment wrapper, installed at bootstrap.** `onApplicationBootstrap` rather than a
 * provider factory, for the reason `DataProtectionModule` installs its model hooks there: the
 * connection must exist and be authenticated first, and a wrapper installed from a factory would
 * run at an unspecified point in the graph's construction.
 *
 * ## Why this module registers no global guard, interceptor or filter
 *
 * Deliberate, and load-bearing. `AppModule`'s import order encodes 00-ARCHITECTURE.md §6's fixed
 * chain and 07-DATA-PROTECTION.md §8's fixed `DTO → mask → serialise → encrypt`, both of which
 * are decided by the order Nest registers `APP_INTERCEPTOR`s in. A module that has to be *first*
 * in that array and also contributes a global interceptor would silently reorder both. This one
 * contributes neither, so its position is free to be chosen for the middleware alone.
 */
import { Inject, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { Logger as WinstonLogger } from 'winston';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Sequelize } from 'sequelize-typescript';
import { DatabaseModule } from '@/database/database.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import {
  CorrelationMiddleware,
  TRACE_LOG_WRITER,
  type TraceLogWriter,
} from './correlation.middleware';
import type { PortalLogLevel } from './logger.config';
import { SpanService } from './span.service';
import { installSqlCommentHook } from './sql-comment.hook';

@Module({
  imports: [DatabaseModule],
  providers: [
    SpanService,
    CorrelationMiddleware,
    {
      // The middleware writes structured records directly rather than through Nest's `Logger`,
      // because a completion line *is* structure — `http`, `db`, `outcome` and the span timeline
      // are fields, not a sentence with fields glued on. `Logger.log(message, context)` has
      // nowhere to put them. Everything else in the codebase keeps using `new Logger(X)` and is
      // redirected here by `app.useLogger` in `main.ts`.
      provide: TRACE_LOG_WRITER,
      inject: [WINSTON_MODULE_PROVIDER],
      useFactory: (logger: WinstonLogger): TraceLogWriter => ({
        log: (level: PortalLogLevel, message: string, meta: Record<string, unknown>): void => {
          logger.log(level, message, meta);
        },
      }),
    },
  ],
  exports: [SpanService],
})
export class TracingModule implements NestModule, OnApplicationBootstrap, OnApplicationShutdown {
  /** Undoes {@link installSqlCommentHook}. Held so shutdown can restore the untouched method. */
  private uninstallSqlComment: (() => void) | null = null;

  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * `forRoutes('*')` — every route, including `@Public()` ones and including paths that match no
   * controller at all. A 404 with no correlation id is a request nobody can investigate, and the
   * requests worth investigating are disproportionately the ones that did not reach a handler.
   *
   * ### The boot-time warning about this pattern is expected, and `'*'` is deliberate
   *
   * On Express 5 / path-to-regexp 8 (both installed), Nest logs at startup:
   *
   * > `Unsupported route path: "/api/v1/*" … Attempting to auto-convert to "/api/v1/{*path}"`
   *
   * The obvious response is to write `'{*path}'` here and silence it. That was not done, because
   * the failure mode of getting a route pattern wrong is **silent**: the middleware would apply
   * to nothing, and no test in this task would fail — every other suite here wires the middleware
   * with `app.use`, which covers everything unconditionally. So the pattern is left as the one
   * whose behaviour has been observed end to end, and `tracing.http.spec.ts`'s
   * "the forRoutes pattern really covers every route" block pins it: a real Nest app, a real
   * `MiddlewareConsumer`, one matched route and one 404, both traced.
   *
   * Changing this line is safe **only** with that block green afterwards.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }

  onApplicationBootstrap(): void {
    this.uninstallSqlComment = installSqlCommentHook(this.sequelize);
  }

  /**
   * Restores `sequelize.query` on shutdown.
   *
   * Not housekeeping: e2e suites build and tear down several applications in one process, and a
   * wrapper left installed on a closed connection would be re-wrapped by the next application —
   * a comment per boot, growing with each one.
   */
  onApplicationShutdown(): void {
    this.uninstallSqlComment?.();
    this.uninstallSqlComment = null;
  }
}
