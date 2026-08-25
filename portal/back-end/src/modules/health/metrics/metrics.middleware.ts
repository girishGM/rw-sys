/**
 * T-052 — `http_requests_total{route,status}` and `http_request_duration_seconds{route}`
 * (08-OBSERVABILITY.md §8), the two metrics this task can populate honestly from the HTTP
 * boundary alone (see `metrics.registry.ts`'s header for the ones it deliberately does not
 * attempt here).
 *
 * Shares `CorrelationMiddleware`'s own shape for a reason, not by coincidence: `res.on('finish')`
 * is the only listener that sees every response with its real status and duration, *and* runs
 * after Express has matched a route — `request.route.path` (what `routeOf` reads) does not exist
 * until routing has happened, so reading it from this middleware's own body, before `next()`,
 * would see nothing. `close` is deliberately not also handled here, unlike the tracing
 * middleware: a `warn`-level "request aborted" log line is worth writing so an engineer can find
 * it by correlation id; a metrics sample for a connection nobody waited on would only skew the
 * duration histogram towards socket-level noise instead of measuring the server's own work.
 */
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { routeOf } from '@/common/tracing/correlation.middleware';
import { MetricsRegistry } from './metrics.registry';

@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsRegistry) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const startedAtNs = process.hrtime.bigint();
    response.on('finish', () => this.record(request, response, startedAtNs));
    next();
  }

  private record(request: Request, response: Response, startedAtNs: bigint): void {
    const route = routeOf(request);
    const status = String(response.statusCode);
    const durationSeconds = Number(process.hrtime.bigint() - startedAtNs) / 1e9;

    this.metrics.incrementCounter('http_requests_total', { route, status });
    this.metrics.observeHistogram('http_request_duration_seconds', { route }, durationSeconds);
  }
}
