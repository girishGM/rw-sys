/**
 * T-RTS-050. Shared observability interceptor for both API surfaces (T-RTS-030/031) — the actual
 * `reward_tracking_api_requests_total{endpoint,status}` call site and the structured-logging call
 * site T-RTS-040 built the reusable primitives for (`src/observability/**`) but could not wire
 * itself, because the consuming controllers live in `src/modules/api/**`, `agent-rts-api`'s
 * exclusive scope, not `agent-rts-qa`'s (R10 — see T-RTS-050's own task file for the full evidence
 * trail this header summarizes).
 *
 * One interceptor, applied via `@UseInterceptors(ApiObservabilityInterceptor)` on both
 * `CustomerRewardsController` and `AdminRewardsController` (R8 — one shared code path, not nine
 * separate per-handler manual `metrics.incrementApiRequest(...)` calls) — a future tenth handler on
 * either controller gets this for free just by being declared under the same controller class,
 * never a call a handler author has to remember to add.
 *
 * `endpoint` is the exact string passed to each handler's own `@Get(...)` decorator, read via
 * `PATH_METADATA` off the handler function — e.g. `'summary'` on the customer controller,
 * `'campaigns/:campaignCode/summary'` on the admin controller, matching T-RTS-050's own task file
 * examples verbatim (never the raw path with interpolated ids, so the series count stays bounded).
 * `status` is the actual HTTP status: `response.statusCode` on a normal completion (every handler
 * here returns a plain object with no `@HttpCode()`, so this is always `200` today, but reading it
 * live rather than hard-coding survives a future `@HttpCode()`), or `error.getStatus()` on a thrown
 * `HttpException` (`400`/`403`/... per T-RTS-050's own evidence — `BadRequestException`,
 * `ForbiddenException`), defaulting to `500` for anything else. The metric increments exactly once
 * per response either way — success or thrown exception, never both, never zero.
 *
 * **Correlation id.** These are read-only GETs with no natural inbound correlation id (T-RTS-050's
 * own evidence: neither controller accepted or logged one before this task). An inbound
 * `X-Correlation-Id` header is honored when present — letting a caller that already knows the
 * correlation id of the ingestion event(s) it's about to read back join the trace, per T-RTS-040's
 * own Objective ("correlation-id tracing across every call site ... and both API surfaces") —
 * otherwise a fresh id is generated per request via `node:crypto`'s `randomUUID()` (no new runtime
 * dependency, same choice `metrics.service.ts`'s own header made, for the same file-scope reason).
 * Echoed back on the response via the same header, so a caller that didn't send one can still
 * capture it for its own logs.
 *
 * **R6.** Never passes a plaintext `customerId`/`customer_id` to `StructuredLogger`. `tenantId`
 * (numeric, both auth shapes) and `campaignCode` (a route param or query string value, never a
 * customer identifier) are the only request-shape fields this interceptor logs — and
 * `StructuredLogger` itself redacts a literal `customerId`/`customer_id` key defensively regardless
 * (`logging.module.ts`'s own header), so a future call-site mistake here would be masked, not a
 * silent leak.
 */
import {
  HttpException,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { MetricsService } from '@/observability/metrics.service';
import { StructuredLoggerFactory, type StructuredLogger } from '@/observability/logging.module';

const CORRELATION_ID_REQUEST_HEADER = 'x-correlation-id';
const CORRELATION_ID_RESPONSE_HEADER = 'X-Correlation-Id';

function resolveCorrelationId(request: Request): string {
  const header = request.headers[CORRELATION_ID_REQUEST_HEADER];
  const raw = Array.isArray(header) ? header[0] : header;
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : randomUUID();
}

/** `@Get(...)`'s own literal argument, off the handler function's metadata — never the controller
 * prefix, matching T-RTS-050's own task file examples (`'summary'`, not
 * `'customers/:customerId/rewards/summary'`). */
function resolveEndpoint(context: ExecutionContext): string {
  const path = Reflect.getMetadata(PATH_METADATA, context.getHandler()) as
    string | string[] | undefined;
  if (Array.isArray(path)) return path[0] ?? 'unknown';
  return path && path.length > 0 ? path : 'unknown';
}

/** Both auth guards attach a numeric `tenantId` (or `null`, for the admin surface's own
 * `super_admin`) under a different, guard-specific request key (`customerAuth`/`portalAdmin`,
 * `customer-auth.guard.ts`/`portal-admin-auth.guard.ts`) — this interceptor runs after whichever
 * guard actually ran, so it reads whichever key is present rather than importing both guards' own
 * request types and coupling this shared file to either one specifically. */
function resolveTenantId(request: Request): number | undefined {
  const authed = request as Request & {
    customerAuth?: { tenantId?: number };
    portalAdmin?: { tenantId?: number | null };
  };
  const fromCustomer = authed.customerAuth?.tenantId;
  if (typeof fromCustomer === 'number') return fromCustomer;
  const fromAdmin = authed.portalAdmin?.tenantId;
  return typeof fromAdmin === 'number' ? fromAdmin : undefined;
}

/** Route param first (every handler that has one names it `campaignCode`), then a query-string
 * fallback (`CustomerRewardsController.getSummary`'s own optional `?campaignCode=`) — never a
 * customer identifier, so this is always safe to log verbatim (R6 note above). */
function resolveCampaignCode(request: Request): string | undefined {
  const paramValue = request.params?.campaignCode;
  if (typeof paramValue === 'string' && paramValue.length > 0) return paramValue;
  const queryValue = request.query?.campaignCode;
  return typeof queryValue === 'string' && queryValue.length > 0 ? queryValue : undefined;
}

function resolveErrorStatus(error: unknown): number {
  return error instanceof HttpException ? error.getStatus() : 500;
}

interface ObservedOutcome {
  endpoint: string;
  status: number;
  correlationId: string;
  tenantId?: number;
  campaignCode?: string;
}

@Injectable()
export class ApiObservabilityInterceptor implements NestInterceptor {
  private readonly logger: StructuredLogger;

  constructor(
    private readonly metrics: MetricsService,
    loggers: StructuredLoggerFactory,
  ) {
    this.logger = loggers.forContext(ApiObservabilityInterceptor.name);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const correlationId = resolveCorrelationId(request);
    response.setHeader(CORRELATION_ID_RESPONSE_HEADER, correlationId);
    const endpoint = resolveEndpoint(context);
    const tenantId = resolveTenantId(request);
    const campaignCode = resolveCampaignCode(request);

    return next.handle().pipe(
      tap(() => {
        this.recordCompletion({
          endpoint,
          status: response.statusCode,
          correlationId,
          tenantId,
          campaignCode,
        });
      }),
      catchError((error: unknown) => {
        this.recordFailure({
          endpoint,
          status: resolveErrorStatus(error),
          correlationId,
          tenantId,
          campaignCode,
        });
        return throwError(() => error);
      }),
    );
  }

  private recordCompletion(outcome: ObservedOutcome): void {
    this.metrics.incrementApiRequest(outcome.endpoint, outcome.status);
    this.logger.log('API request completed', this.toLogFields(outcome));
  }

  private recordFailure(outcome: ObservedOutcome): void {
    this.metrics.incrementApiRequest(outcome.endpoint, outcome.status);
    const fields = this.toLogFields(outcome);
    if (outcome.status >= 500) {
      this.logger.error('API request failed', fields);
    } else {
      this.logger.warn('API request rejected', fields);
    }
  }

  private toLogFields(outcome: ObservedOutcome) {
    return {
      correlationId: outcome.correlationId,
      ...(outcome.tenantId !== undefined ? { tenantId: outcome.tenantId } : {}),
      ...(outcome.campaignCode !== undefined ? { campaignCode: outcome.campaignCode } : {}),
      endpoint: outcome.endpoint,
      status: outcome.status,
    };
  }
}
