import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { DatabaseModule } from '@/database/database.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { MetricsMiddleware } from './metrics/metrics.middleware';
import { MetricsModule } from './metrics/metrics.module';

/**
 * T-052 extended this module with `HealthService` (the `/health/ready` DB check, via the
 * `SEQUELIZE` token `DatabaseModule` exports — no direct model access, so R2 does not apply)
 * and `MetricsModule` (the `/metrics` registry, served on its own port by `metrics-server.ts`
 * from `main.ts`, never through this module's own controller — see that file's header for why
 * it is a second, unregistered HTTP listener rather than a route on this one).
 *
 * `DatabaseModule` is imported explicitly (not `@Global()`) so `HealthService` can inject
 * `SEQUELIZE` — Nest resolves the same underlying connection `AppModule`'s own
 * `DatabaseModule` import already built, not a second one; a provider behind a factory with
 * `useFactory` runs its factory once per module registration only if the module itself is
 * re-instantiated, and Nest de-duplicates module instances by class reference, so this does
 * not open a second pool.
 *
 * `configure()` applies `MetricsMiddleware` to **every** route in the application, not just
 * this module's own two — `MiddlewareConsumer.forRoutes('*')` registers on the shared Express
 * instance, the same mechanism `TracingModule`'s `CorrelationMiddleware` already uses, so this
 * module's file scope (`back-end/src/modules/health/**`) is enough to wire up
 * `http_requests_total`/`http_request_duration_seconds` application-wide without editing
 * `main.ts` or any other module.
 */
@Module({
  imports: [DatabaseModule, MetricsModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(MetricsMiddleware).forRoutes('*');
  }
}
