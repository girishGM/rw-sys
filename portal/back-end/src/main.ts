import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, type LoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureHttpSecurity } from '@/common/security/security.middleware';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import type { Env } from '@/config/env.schema';

/**
 * Registration points below are additive — later tasks add their own `app.use(...)` /
 * `app.enable*(...)` line in the marked section rather than restructuring this function
 * (05-EXECUTION-PLAN.md §3). T-012 adds helmet/CORS/CSRF/rate-limit here; T-019 adds the
 * correlation middleware.
 *
 * **T-018 added nothing to this function**, and that is the correct outcome rather than an
 * omission. The comment above anticipated an `app.useGlobalInterceptors(...)` line here for the
 * payload-decryption interceptor. Registering it that way would put its position in the chain
 * outside this file's control: `useGlobalInterceptors` runs *after* `NestFactory.create` has
 * already applied every `APP_INTERCEPTOR`, so where it lands relative to
 * `ResponseMaskingInterceptor` is an artefact of that timing rather than a decision. And that
 * position is not a detail — 07-DATA-PROTECTION.md §8 fixes the order as
 * `DTO → mask → serialise → encrypt`, and getting it wrong builds the envelope from the unmasked
 * body with nothing visibly failing.
 *
 * Both interceptors are therefore `APP_INTERCEPTOR`s in `TransportCryptoModule`, whose position
 * in `AppModule.imports` states the ordering explicitly and in one place. See the note there.
 */
async function bootstrap(): Promise<void> {
  // T-012 pinned the application type to Express. It always was one (`@nestjs/platform-express`
  // is the only adapter installed); naming it is what gives `configureHttpSecurity` access to
  // `set('trust proxy', …)` and `useBodyParser`, without a cast that would hide a genuine
  // platform mismatch until runtime.
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // T-019 — the one line that makes every `new Logger(X)` in the codebase write 08-OBSERVABILITY
  // §3's JSON envelope instead of Nest's prose console format: `AuditService`'s failed-write
  // record, `ErrorNormalizationFilter`'s 5xx line, `SessionService`'s refresh-reuse `warn`
  // (TC-21) and everything Wave 3 adds, all through the T-017 masking serialiser and all
  // carrying the correlation id from the `AsyncLocalStorage` context. No call site changes.
  //
  // It is placed immediately after `create` so that the smallest possible number of boot lines
  // are written by the default logger. `CorrelationMiddleware` is not registered here at all —
  // `TracingModule.configure()` applies it, so its position is fixed by that module's place in
  // `AppModule.imports` (first) rather than by the order of statements in this function, which is
  // the same reasoning T-018's note below gives for its interceptors.
  app.useLogger(app.get<LoggerService>(WINSTON_MODULE_NEST_PROVIDER));

  // Flushes the logger and closes the pool on SIGTERM/SIGINT, and — the reason it is needed here
  // rather than merely being tidy — runs `TracingModule.onApplicationShutdown`, which restores
  // the `sequelize.query` wrapper.
  app.enableShutdownHooks();

  // --- security / request-shape baseline (T-001) ---------------------------------------
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // T-014 — the one option this task adds to a pipe it does not own. Without it,
      // `ValidationPipe` throws a `BadRequestException` carrying an array of English sentences
      // ("email must be an email"), and the structured `ValidationError[]` — the only place the
      // failing property and constraint still exist as data — is discarded before any filter can
      // see it. 03-API-CONTRACT.md §1 requires `details: [{ field, code }]`, and TC-11 requires
      // "no internal messages", so the factory converts the structure and drops the prose.
      // Everything else about this pipe is untouched. See `validation.exception-factory.ts`.
      exceptionFactory: validationExceptionFactory,
    }),
  );
  // --- later tasks append their own middleware/guards here, in the order 00-ARCHITECTURE
  //     §6 specifies (helmet → CORS → rate limit → CSRF → JwtAuthGuard → SessionValidGuard
  //     → RolesGuard → PermissionsGuard → TenancyScopeInterceptor → ... → AuditInterceptor
  //     → ErrorNormalisationFilter). Do not reorder what earlier tasks already placed. ----

  const configService = app.get(ConfigService<Env>);

  // T-012 — chain positions 1 and 2 (headers/CSP, CORS) plus HTTPS enforcement, proxy trust and
  // the 1 MB body limit. Positions 3 and 4 (RateLimitGuard, CsrfGuard) are global guards
  // registered by `SecurityModule`, not here, so their order is fixed by DI rather than by the
  // order of statements in this function. See `security.middleware.ts`.
  configureHttpSecurity(app, {
    apiOrigin: configService.get('API_ORIGIN', { infer: true }) ?? '',
    corsAllowedOrigins: configService.get('CORS_ALLOWED_ORIGINS', { infer: true }),
    trustProxy: configService.get('TRUST_PROXY', { infer: true }),
    // HTTPS is enforced in production only. `development` and `test` are the two local
    // environments the enum allows, and redirecting there would break `http://localhost`
    // development and every e2e run without protecting anything — the traffic never leaves
    // the machine. Every deployed environment sets `NODE_ENV=production` (02-SECURITY.md §7:
    // "HTTPS enforced in every non-local environment").
    enforceHttps: configService.get('NODE_ENV', { infer: true }) === 'production',
  });

  const port = configService.get('PORT', { infer: true }) ?? 3000;

  await app.listen(port);
}

bootstrap();
