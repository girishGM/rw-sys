/**
 * T-PC-042. HTTP-transport entry point for `CorrelationContextService`. Reads an inbound
 * `x-correlation-id` header when the caller already has one (e.g. a portal-side request that
 * wants to trace across services), otherwise mints a fresh one — every log line for the rest of
 * this request's lifecycle (including anything logged deeper in `PromoCodeConfigService`/
 * `CampaignBindingService`, neither of which this task edits) then carries it, via
 * `StructuredLoggerService` reading the same `AsyncLocalStorage` context.
 *
 * Applied globally in `logging.module.ts`'s own `configure()` — this task's own module
 * registering itself against every route, not an edit to any controller file (R8).
 */
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { CorrelationContextService } from './correlation-context.service';

const CORRELATION_ID_HEADER = 'x-correlation-id';

@Injectable()
export class CorrelationContextMiddleware implements NestMiddleware {
  constructor(private readonly correlationContext: CorrelationContextService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const headerValue = req.headers[CORRELATION_ID_HEADER];
    const correlationId =
      (Array.isArray(headerValue) ? headerValue[0] : headerValue) || randomUUID();

    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    this.correlationContext.run(
      { correlationId, transport: 'HTTP', rpc: `${req.method} ${req.path}` },
      () => {
        next();
      },
    );
  }
}
