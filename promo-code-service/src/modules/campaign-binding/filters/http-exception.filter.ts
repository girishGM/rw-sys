/**
 * T-PC-012. Translates this module's typed domain errors (`campaign-binding.errors.ts`,
 * deliberately plain `Error` subclasses with no HTTP dependency) into the REST status codes
 * `04-API-CONTRACT.md` §2 requires — same pattern (and same reasoning for not living under
 * `src/common/**`, which this agent's file scope does not grant) as `promo-code-config/filters/
 * http-exception.filter.ts` (T-PC-011). Kept as this module's own copy rather than importing
 * that one, since the two modules map a disjoint set of error types to statuses and a shared
 * filter would need to know about both modules' errors — the opposite of the "thin adapter"
 * discipline `AGENT-PROTOCOL.md` R10 asks for elsewhere in this service.
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
  BindingConflictError,
  CampaignBindingValidationError,
  ConfigNotActiveError,
} from '../campaign-binding.errors';

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
    if (exception instanceof CampaignBindingValidationError) {
      return new BadRequestException({
        statusCode: 400,
        message: 'Validation failed',
        errors: exception.issues,
      });
    }
    if (exception instanceof ConfigNotActiveError) {
      return new ConflictException({
        statusCode: 409,
        message: exception.message,
      });
    }
    if (exception instanceof BindingConflictError) {
      return new ConflictException({
        statusCode: 409,
        message: exception.message,
      });
    }
    if (exception instanceof HttpException) {
      return exception;
    }
    this.logger.error('Unhandled exception in campaign-binding REST layer', exception as Error);
    return new HttpException('Internal server error', 500);
  }
}
