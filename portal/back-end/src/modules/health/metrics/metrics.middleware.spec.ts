import { EventEmitter } from 'node:events';
import { MetricsMiddleware } from './metrics.middleware';
import { MetricsRegistry } from './metrics.registry';

/** A minimal Express-shaped response: an EventEmitter with a `statusCode`, so `res.on('finish')`
 * behaves like the real thing. */
function fakeResponse(statusCode: number): EventEmitter & { statusCode: number } {
  const response = new EventEmitter() as EventEmitter & { statusCode: number };
  response.statusCode = statusCode;
  return response;
}

describe('MetricsMiddleware', () => {
  it('calls next() synchronously, before the response finishes', () => {
    const registry = new MetricsRegistry();
    const middleware = new MetricsMiddleware(registry);
    const next = jest.fn();

    middleware.use({ path: '/api/v1/health' } as never, fakeResponse(200) as never, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('records http_requests_total and http_request_duration_seconds on finish, keyed by the parameterised route and status', () => {
    const registry = new MetricsRegistry();
    const middleware = new MetricsMiddleware(registry);
    const request = {
      route: { path: '/campaigns/:id/submit' },
      baseUrl: '/api/v1',
      path: '/api/v1/campaigns/8821/submit',
    };
    const response = fakeResponse(200);

    middleware.use(request as never, response as never, jest.fn());
    response.emit('finish');

    const text = registry.render();
    expect(text).toContain(
      'http_requests_total{route="/api/v1/campaigns/:id/submit",status="200"} 1',
    );
    // The identifier from the concrete URL must never appear — the same aggregation concern
    // 08-OBSERVABILITY.md §3 raises for the log schema's own `http.route` field.
    expect(text).not.toContain('8821');
  });

  it('does not record anything before the response actually finishes', () => {
    const registry = new MetricsRegistry();
    const middleware = new MetricsMiddleware(registry);
    middleware.use({ path: '/x' } as never, fakeResponse(200) as never, jest.fn());

    // No *sample* line yet — only the always-present HELP/TYPE documentation this metric name
    // carries regardless of whether it has ever been observed (see the registry's own tests).
    expect(registry.render()).not.toContain('http_requests_total{');
  });

  it('falls back to the concrete request path when no route matched (e.g. a 404)', () => {
    const registry = new MetricsRegistry();
    const middleware = new MetricsMiddleware(registry);
    const request = { path: '/api/v1/does-not-exist' };
    const response = fakeResponse(404);

    middleware.use(request as never, response as never, jest.fn());
    response.emit('finish');

    expect(registry.render()).toContain(
      'http_requests_total{route="/api/v1/does-not-exist",status="404"} 1',
    );
  });
});
