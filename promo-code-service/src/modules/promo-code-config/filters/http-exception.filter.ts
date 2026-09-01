/**
 * T-PC-011. Translates this module's typed domain errors (`promo-code-config.errors.ts`, owned
 * by T-PC-010, deliberately plain `Error` subclasses with no HTTP dependency of their own — see
 * that file's header) into the REST status codes `04-API-CONTRACT.md` §3 and this task's
 * implementation notes 4/5 require, so a caller never sees a raw driver/validation exception or
 * an undifferentiated `500`.
 *
 * Deviation from the task file's literal path (`src/common/filters/http-exception.filter.ts`):
 * same reasoning as `guards/internal-service-token.guard.ts` in this same directory — `src/common/**`
 * is not part of this agent's granted file scope. Applied per-controller via `@UseFilters(...)`
 * rather than globally in `main.ts` (owned by `agent-promo-foundation`), which is functionally
 * equivalent for the one controller this task ships and the one T-PC-012 will add to the same
 * scope.
 */
import {
  ArgumentsHost,
  Catch,
  ConflictException,
  ExceptionFilter,
  HttpException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ConfigNameConflictError,
  PromoCodeConfigValidationError,
} from '../promo-code-config.errors';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const mapped = this.mapException(exception);
    const status = mapped.getStatus();
    response.status(status).json(mapped.getResponse());
  }

  private mapException(exception: unknown): HttpException {
    if (exception instanceof PromoCodeConfigValidationError) {
      return new BadRequestException({
        statusCode: 400,
        message: 'Validation failed',
        errors: exception.issues,
      });
    }
    if (exception instanceof ConfigNameConflictError) {
      return new ConflictException({
        statusCode: 409,
        message: exception.message,
      });
    }
    if (exception instanceof HttpException) {
      return exception;
    }
    // Anything else is an unexpected/unmapped error — never leak internal detail to the
    // caller (stack traces, driver messages), but still log it server-side so a genuine bug
    // isn't silently swallowed behind a generic 500.
    this.logger.error('Unhandled exception in promo-code-config REST layer', exception as Error);
    return new HttpException('Internal server error', 500);
  }
}
