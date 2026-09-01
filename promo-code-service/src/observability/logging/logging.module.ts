/**
 * T-PC-042. Installing this module's `StructuredLoggerService` as the process-wide Nest logger
 * happens in this module's own constructor (not `onModuleInit`) — deliberately as early in the
 * DI graph's construction phase as Nest allows, so as few framework-internal bootstrap log lines
 * as possible are emitted through the default `ConsoleLogger` before the override takes effect.
 * `Logger.overrideLogger` is a static, process-global call (`structured-logger.service.ts`'s own
 * header) — it needs to run exactly once per process, not once per `TestingModule` compile, which
 * is why `install()` is idempotent (safe to call repeatedly across many `Test.createTestingModule`
 * calls in the same Jest worker process, e.g. one per spec file).
 */
import { Logger, MiddlewareConsumer, Module, RequestMethod, type NestModule } from '@nestjs/common';
import { CorrelationContextMiddleware } from './correlation-context.middleware';
import { CorrelationContextService } from './correlation-context.service';
import { StructuredLoggerService } from './structured-logger.service';

@Module({
  providers: [CorrelationContextService, StructuredLoggerService, CorrelationContextMiddleware],
  exports: [CorrelationContextService, StructuredLoggerService],
})
export class LoggingModule implements NestModule {
  constructor(private readonly structuredLogger: StructuredLoggerService) {
    Logger.overrideLogger(this.structuredLogger);
  }

  /**
   * Applied to every route of whichever Express-based Nest application imports this module
   * (only the HTTP `AppModule` process today — this task's own module registering itself
   * against every route, never an edit to a controller file, R8). `'*path'` (a *named*
   * wildcard), not the bare `'*'` Nest <10 accepted — this project's `path-to-regexp` (via
   * Express 5) is v8, which dropped the unnamed-wildcard form.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CorrelationContextMiddleware)
      .forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
